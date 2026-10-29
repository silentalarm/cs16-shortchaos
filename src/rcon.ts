import { createSocket, type Socket } from "node:dgram";

/**
 * Minimal RCON client for GoldSrc/HLDS over UDP.
 *
 * Why our own: an npm package for a 40-line protocol is more supply-chain risk than value,
 * and we want explicit control over timeouts and over what reaches the game server.
 *
 * GoldSrc does NOT use the binary size/id/type packets of the Source engine. The real wire
 * format is connectionless text, verified against a live ReHLDS:
 *   1. -> \xFF\xFF\xFF\xFF "challenge rcon\0"           <- \xFF\xFF\xFF\xFF "challenge rcon <n>\n\0"
 *   2. -> \xFF\xFF\xFF\xFF "rcon <n> \"<pass>\" <cmd>\0" <- \xFF\xFF\xFF\xFF 'l' <output> "\n\0"
 * A command sent without a fresh challenge is answered with "No challenge for your address".
 */
const HEADER = Buffer.from([0xff, 0xff, 0xff, 0xff]);
const CHALLENGE_COMMAND = "challenge rcon";
/** After the first output datagram keep listening this long for trailing chunks. */
const IDLE_MS = 150;

export interface RconOptions {
  host: string;
  port: number;
  password: string;
  timeoutMs?: number;
}

interface Reply {
  /** First byte after the 0xFFFFFFFF header: 'l' for command output, 'A' for A2S, etc. */
  code: string;
  text: string;
}

export class RconError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RconError";
  }
}

function encodeRequest(body: string): Buffer {
  return Buffer.concat([HEADER, Buffer.from(body, "latin1"), Buffer.from([0])]);
}

/** Returns null for datagrams that are not rcon replies (wrong header or too short). */
function decodeReply(data: Buffer): Reply | null {
  if (data.length < 5) return null;
  if (data[0] !== 0xff || data[1] !== 0xff || data[2] !== 0xff || data[3] !== 0xff) return null;
  return {
    code: String.fromCharCode(data[4] ?? 0),
    text: data.toString("latin1", 5).replace(/\0+$/u, ""),
  };
}

export class RconClient {
  readonly #socket: Socket;
  readonly #timeoutMs: number;
  readonly #password: string;
  readonly #handlers = new Set<(reply: Reply) => void>();
  #challenge = "";
  #closed = false;
  /**
   * Tail of the FIFO queue. GoldSrc RCON has no request id: a reply datagram carries only the output
   * text, so the only way to know which command it belongs to is to keep exactly one command in
   * flight. Everything sent through this client chains onto this promise.
   */
  #tail: Promise<void> = Promise.resolve();

  private constructor(socket: Socket, timeoutMs: number, password: string) {
    this.#socket = socket;
    this.#timeoutMs = timeoutMs;
    this.#password = password;
    socket.on("message", (data: Buffer) => this.#onMessage(data));
    socket.on("error", () => this.#close());
    socket.on("close", () => this.#close());
  }

  static async connect(options: RconOptions): Promise<RconClient> {
    const timeoutMs = options.timeoutMs ?? 5000;
    if (/["\\\r\n]/u.test(options.password)) {
      throw new RconError("RCON password may not contain quotes, backslashes or newlines");
    }

    const socket = createSocket("udp4");
    await new Promise<void>((resolve, reject) => {
      socket.once("error", (error: Error) => {
        socket.close();
        reject(new RconError(`RCON socket error: ${error.message}`));
      });
      socket.connect(options.port, options.host, () => {
        socket.removeAllListeners("error");
        resolve();
      });
    });

    const client = new RconClient(socket, timeoutMs, options.password);
    try {
      await client.#refreshChallenge();
    } catch (error) {
      client.close();
      throw error;
    }
    return client;
  }

  /** Fetches a fresh challenge token; HLDS rejects commands without one. */
  async #refreshChallenge(): Promise<void> {
    const pending = this.#wait((item) => /challenge rcon \d+/u.test(item.code + item.text), "challenge");
    this.#send(CHALLENGE_COMMAND).catch(() => undefined);
    const answered = await pending;
    const match = /challenge rcon (\d+)/u.exec(answered.code + answered.text);
    if (!match?.[1]) throw new RconError(`unexpected RCON challenge reply: ${(answered.code + answered.text).trim().slice(0, 80)}`);
    this.#challenge = match[1];
  }

  /**
   * Runs a console command and resolves with the server reply.
   *
   * The whole exchange goes through the FIFO queue below, not just the send: the datagram collector
   * is what gets confused when two commands are in flight at once.
   */
  exec(command: string): Promise<string> {
    // Refused before it reaches the queue: a broken line must not wait behind three healthy ones.
    if (/[\r\n\0]/u.test(command)) return Promise.reject(new RconError("RCON command must be a single line"));
    return this.#enqueue(async () => {
      if (this.#closed) throw new RconError("RCON connection is closed");
      if (!this.#challenge) await this.#refreshChallenge();

      const body = `rcon ${this.#challenge} "${this.#password}" ${command}`;
      return this.#collect(body);
    });
  }

  close(): void {
    this.#close();
  }

  #close(): void {
    this.#closed = true;
    this.#handlers.clear();
    try {
      this.#socket.close();
    } catch {
      // already closed
    }
  }

  /**
   * Runs `task` after every command queued before it, and resolves with its result.
   *
   * The failure branch replays the next task too: a rejected command (timeout, expired challenge)
   * must not leave the queue permanently broken for the rest of the stream. `#tail` itself is always
   * a resolving promise, so one rejection is not carried forward.
   */
  #enqueue<T>(task: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(task, task);
    this.#tail = result.then(() => undefined, () => undefined);
    return result;
  }

  #send(body: string): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.#closed) {
        reject(new RconError("RCON socket is closed"));
        return;
      }
      this.#socket.send(encodeRequest(body), (error) => {
        if (error) reject(new RconError(`RCON send failed: ${error.message}`));
        else resolve();
      });
    });
  }

  /** Collects every output datagram of one command until the line goes quiet. */
  #collect(body: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const chunks: string[] = [];
      let idle: ReturnType<typeof setTimeout> | undefined;

      const finish = (error?: RconError): void => {
        clearTimeout(guard);
        if (idle) clearTimeout(idle);
        this.#handlers.delete(handler);
        if (error) reject(error);
        else resolve(chunks.join("").trimEnd());
      };

      const handler = (reply: Reply) => {
        if (reply.code !== "l") return;
        if (/bad rcon_password/iu.test(reply.text)) {
          finish(new RconError("RCON authentication rejected (wrong rcon_password)"));
          return;
        }
        if (/no challenge for your address/iu.test(reply.text)) {
          this.#challenge = "";
          finish(new RconError("RCON challenge expired; reconnect"));
          return;
        }
        chunks.push(reply.text);
        if (idle) clearTimeout(idle);
        idle = setTimeout(() => finish(), IDLE_MS);
      };

      const guard = setTimeout(() => {
        if (chunks.length > 0) finish();
        else finish(new RconError(`RCON command timed out after ${this.#timeoutMs} ms`));
      }, this.#timeoutMs);

      this.#handlers.add(handler);
      this.#send(body).catch((error: Error) => finish(error as RconError));
    });
  }

  #wait(predicate: (reply: Reply) => boolean, label: string): Promise<Reply> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#handlers.delete(handler);
        reject(new RconError(`RCON ${label} timed out after ${this.#timeoutMs} ms`));
      }, this.#timeoutMs);

      const handler = (reply: Reply) => {
        if (!predicate(reply)) return;
        clearTimeout(timer);
        this.#handlers.delete(handler);
        resolve(reply);
      };

      this.#handlers.add(handler);
    });
  }

  #onMessage(data: Buffer): void {
    const reply = decodeReply(data);
    if (!reply) return;
    for (const handler of [...this.#handlers]) handler(reply);
  }
}

/** Convenience wrapper: connect, run one command, close. */
export async function execOnce(options: RconOptions, command: string): Promise<string> {
  const client = await RconClient.connect(options);
  try {
    return await client.exec(command);
  } finally {
    client.close();
  }
}
