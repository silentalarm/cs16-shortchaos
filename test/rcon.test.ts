import { after, test } from "node:test";
import assert from "node:assert/strict";
import { createSocket, type Socket } from "node:dgram";
import { RconClient, RconError, execOnce } from "../src/rcon.ts";

interface FakeServer {
  port: number;
  commands: string[];
  /** Largest number of commands the server was handling at the same time. */
  peakInFlight: () => number;
  close: () => Promise<void>;
}

const HEADER = Buffer.from([0xff, 0xff, 0xff, 0xff]);
const sockets: Socket[] = [];

after(() => {
  for (const socket of sockets) {
    try {
      socket.close();
    } catch {
      // already closed
    }
  }
});

function raw(text: string): Buffer {
  return Buffer.concat([HEADER, Buffer.from(text, "latin1"), Buffer.from([0])]);
}

function output(text: string): Buffer {
  return raw(`l${text}\n`);
}

async function startFake(options: {
  password: string;
  reply?: (command: string) => string;
  silent?: boolean;
  extraChunk?: string;
  noChallenge?: boolean;
  /** Delay before a command is answered; makes overlapping requests visible. */
  replyDelayMs?: number;
}): Promise<FakeServer> {
  const commands: string[] = [];
  let inFlight = 0;
  let peak = 0;
  const socket = createSocket("udp4");
  sockets.push(socket);

  socket.on("message", (data: Buffer, rinfo) => {
    if (options.silent) return;
    const text = data.toString("latin1", 4).replace(/\0+$/u, "");
    const send = (buffer: Buffer, delayMs = 0): void => {
      setTimeout(() => {
        try {
          socket.send(buffer, rinfo.port, rinfo.address);
        } catch {
          // server closed mid-test
        }
      }, delayMs);
    };

    if (text === "challenge rcon") {
      send(raw("challenge rcon 4242\n"));
      return;
    }

    const match = /^rcon (\d+) "(.*)" (.*)$/su.exec(text);
    if (!match) {
      send(output("Malformed rcon packet"));
      return;
    }
    const [, challenge, password, command = ""] = match;
    if (challenge !== "4242" || options.noChallenge === true) {
      send(output("No challenge for your address."));
      return;
    }
    if (password !== options.password) {
      send(output("Bad rcon_password."));
      return;
    }

    commands.push(command);
    inFlight += 1;
    if (inFlight > peak) peak = inFlight;

    const delayMs = options.replyDelayMs ?? 0;
    send(output(options.reply ? options.reply(command) : ""), delayMs);
    if (options.extraChunk) send(output(options.extraChunk), delayMs + 30);
    // The command stops being "in flight" once its answer is on the wire, not when it was parsed.
    setTimeout(() => { inFlight -= 1; }, delayMs);
  });

  await new Promise<void>((resolve) => socket.bind(0, "127.0.0.1", resolve));
  const address = socket.address();

  return {
    port: address.port,
    commands,
    peakInFlight: () => peak,
    close: () => new Promise<void>((resolve) => socket.close(() => resolve())),
  };
}

test("connects with a challenge and runs a command", async () => {
  const fake = await startFake({ password: "secret", reply: (command) => `done:${command}` });
  const client = await RconClient.connect({ host: "127.0.0.1", port: fake.port, password: "secret" });
  try {
    assert.equal(await client.exec("amx_de codes"), "done:amx_de codes");
    assert.deepEqual(fake.commands, ["amx_de codes"]);
  } finally {
    client.close();
    await fake.close();
  }
});

test("a wrong password is reported instead of silently failing", async () => {
  const fake = await startFake({ password: "secret" });
  const client = await RconClient.connect({ host: "127.0.0.1", port: fake.port, password: "wrong" });
  try {
    await assert.rejects(client.exec("amx_de version"), /authentication rejected/);
  } finally {
    client.close();
    await fake.close();
  }
});

test("trailing reply datagrams are appended to the same answer", async () => {
  const fake = await startFake({ password: "pw", reply: () => "10 activities:", extraChunk: " bot_nick ..." });
  const client = await RconClient.connect({ host: "127.0.0.1", port: fake.port, password: "pw", timeoutMs: 2000 });
  try {
    assert.equal(await client.exec("amx_de codes"), "10 activities:\n bot_nick ...");
  } finally {
    client.close();
    await fake.close();
  }
});

test("a stale challenge is reported instead of hanging", async () => {
  const fake = await startFake({ password: "pw", noChallenge: true });
  const client = await RconClient.connect({ host: "127.0.0.1", port: fake.port, password: "pw", timeoutMs: 500 });
  try {
    await assert.rejects(client.exec("amx_de codes"), /challenge expired/);
  } finally {
    client.close();
    await fake.close();
  }
});

test("multi line commands never reach the socket", async () => {
  const fake = await startFake({ password: "pw" });
  const client = await RconClient.connect({ host: "127.0.0.1", port: fake.port, password: "pw" });
  try {
    await assert.rejects(client.exec("amx_de codes\nquit"), RconError);
    await assert.rejects(client.exec("amx_de codes\rquit"), /single line/);
    assert.deepEqual(fake.commands, [], "nothing was sent");
  } finally {
    client.close();
    await fake.close();
  }
});

test("a password with quotes is refused before it reaches the wire", async () => {
  const fake = await startFake({ password: "pw" });
  await assert.rejects(
    RconClient.connect({ host: "127.0.0.1", port: fake.port, password: 'p"w' }),
    /may not contain quotes/,
  );
  await fake.close();
});

test("a silent server times out with a readable error", async () => {
  const fake = await startFake({ password: "pw", silent: true });
  await assert.rejects(
    RconClient.connect({ host: "127.0.0.1", port: fake.port, password: "pw", timeoutMs: 150 }),
    /challenge timed out/,
  );
  await fake.close();
});

test("commands issued at the same time are serialized and their replies never cross", async () => {
  // The pollers call exec() through Promise.all; the protocol has no request id, so the only thing
  // that keeps "cmd2" out of the "cmd1" answer is the queue inside the client.
  const fake = await startFake({
    password: "pw",
    replyDelayMs: 25,
    reply: (command) => `${command}:ok`,
  });
  const client = await RconClient.connect({ host: "127.0.0.1", port: fake.port, password: "pw" });
  try {
    const answers = await Promise.all([
      client.exec("cmd1"),
      client.exec("cmd2"),
      client.exec("cmd3"),
    ]);

    assert.deepEqual(answers, ["cmd1:ok", "cmd2:ok", "cmd3:ok"], "an answer landed in the wrong promise");
    assert.deepEqual(fake.commands, ["cmd1", "cmd2", "cmd3"], "the commands did not keep their order");
    assert.equal(fake.peakInFlight(), 1, "two commands were in flight on the same socket");
  } finally {
    client.close();
    await fake.close();
  }
});

test("a failed command does not poison the commands queued behind it", async () => {
  const fake = await startFake({ password: "pw", replyDelayMs: 10, reply: (command) => `${command}:ok` });
  const client = await RconClient.connect({ host: "127.0.0.1", port: fake.port, password: "pw", timeoutMs: 400 });
  try {
    const [first, second] = await Promise.all([
      client.exec("cmd1\nquit"),
      client.exec("cmd2"),
    ].map((promise) => promise.catch((error: unknown) => (error as Error).message)));

    assert.match(first ?? "", /single line/);
    assert.equal(second, "cmd2:ok", "the queue stopped after one rejected command");
  } finally {
    client.close();
    await fake.close();
  }
});

test("execOnce opens and closes its own connection", async () => {
  const fake = await startFake({ password: "pw", reply: () => "ok" });
  assert.equal(await execOnce({ host: "127.0.0.1", port: fake.port, password: "pw" }, "amx_de version"), "ok");
  assert.deepEqual(fake.commands, ["amx_de version"]);
  await fake.close();
});
