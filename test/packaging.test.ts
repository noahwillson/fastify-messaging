import { execFileSync } from "child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { dirname, join, resolve } from "path";
import { beforeAll, describe, expect, it } from "vitest";

const root = resolve(__dirname, "..");

/** Run a CommonJS snippet in a fresh Node process from the package root (self-reference). */
function runNode(code: string): string {
  return execFileSync(process.execPath, ["-e", code], { cwd: root, encoding: "utf8" }).trim();
}

/** Every module specifier a .d.ts file (transitively, within dist) imports. */
function declarationImports(entry: string, seen = new Set<string>()): Set<string> {
  const specifiers = new Set<string>();
  const visit = (file: string) => {
    if (seen.has(file)) return;
    seen.add(file);
    const source = readFileSync(file, "utf8");
    for (const [, spec] of source.matchAll(/(?:from|import\(|module)\s*["']([^"']+)["']/g)) {
      if (spec.startsWith(".")) {
        const base = resolve(dirname(file), spec);
        const next = [`${base}.d.ts`, join(base, "index.d.ts")].find(existsSync);
        if (next) visit(next);
      } else {
        specifiers.add(spec);
      }
    }
  };
  visit(resolve(root, entry));
  return specifiers;
}

describe("package entry points", () => {
  beforeAll(() => {
    execFileSync("npm", ["run", "build"], { cwd: root, stdio: "ignore" });
  }, 120000);

  it.each([
    ["fastify-messaging", ["RabbitMQClient", "fastifyMessaging"]],
    ["fastify-messaging/core", ["RabbitMQClient", "MessagingClient", "SubscriptionError"]],
    ["fastify-messaging/fastify", ["RabbitMQClient", "fastifyMessaging"]],
    ["fastify-messaging/express", ["RabbitMQClient", "expressMessaging"]],
  ])("%s exports %j", (specifier, names) => {
    const exported = JSON.parse(runNode(`console.log(JSON.stringify(Object.keys(require(${JSON.stringify(specifier)}))))`));

    expect(exported).toEqual(expect.arrayContaining(names));
  });

  it.each(["fastify-messaging/core", "fastify-messaging/express"])(
    "%s does not load Fastify at runtime",
    (specifier) => {
      const loaded = runNode(
        `require(${JSON.stringify(specifier)});` +
          `console.log(Object.keys(require.cache).filter((k) => /node_modules[\\\\/](fastify|fastify-plugin)[\\\\/]/.test(k)).length)`
      );

      expect(loaded).toBe("0");
    }
  );

  it.each([
    ["core", "dist/core.d.ts"],
    ["express", "dist/express.d.ts"],
  ])("%s type declarations do not reference fastify", (_name, entry) => {
    const imports = declarationImports(entry);

    expect([...imports].filter((s) => s.startsWith("fastify"))).toEqual([]);
  });

  it("keeps deep imports into dist working", () => {
    const exported = runNode(
      `console.log(typeof require("fastify-messaging/dist/providers/rabbitmq/rabbitmq-client").RabbitMQClient)`
    );

    expect(exported).toBe("function");
  });

  it.each([
    ["node10", "commonjs"],
    ["node16", "node16"],
  ])("resolves subpath types for TypeScript consumers (moduleResolution %s)", (resolution, mod) => {
    const dir = mkdtempSync(join(tmpdir(), "fm-consumer-"));
    try {
      mkdirSync(join(dir, "node_modules"));
      symlinkSync(root, join(dir, "node_modules", "fastify-messaging"), "dir");
      writeFileSync(
        join(dir, "consumer.ts"),
        [
          'import { expressMessaging, ExpressAppLike, RabbitMQClient } from "fastify-messaging/express";',
          'import { SubscriptionError } from "fastify-messaging/core";',
          'import { fastifyMessaging } from "fastify-messaging/fastify";',
          'const client = new RabbitMQClient({ url: "amqp://localhost", exchange: "x" });',
          "declare const app: ExpressAppLike;",
          "export const ready: Promise<{ shutdown(): Promise<void> }> = expressMessaging(app, { client });",
          "export const types = [SubscriptionError, fastifyMessaging];",
        ].join("\n")
      );
      writeFileSync(
        join(dir, "tsconfig.json"),
        JSON.stringify({
          compilerOptions: {
            strict: true,
            noEmit: true,
            module: mod,
            moduleResolution: resolution,
            esModuleInterop: true,
            types: ["node"],
            typeRoots: [join(root, "node_modules/@types")],
          },
          files: ["consumer.ts"],
        })
      );

      execFileSync(process.execPath, [join(root, "node_modules/typescript/bin/tsc"), "-p", dir], {
        encoding: "utf8",
      });
    } catch (error: any) {
      throw new Error(error.stdout || error.message);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("marks framework peers as optional", () => {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

    expect(pkg.peerDependenciesMeta).toMatchObject({
      fastify: { optional: true },
      express: { optional: true },
    });
  });
});
