import "./env.js";
import { RuntimeServer } from "./server.js";

const host = process.env.SZTU_TS_HOST ?? process.env.SZTU_HOST ?? "127.0.0.1";
const port = Number(process.env.SZTU_TS_PORT ?? process.env.SZTU_PORT ?? 7438);
const server = new RuntimeServer(host, port);
console.log(`SztuCode TypeScript runtime listening on ${await server.listen()}`);

const shutdown = async () => { await server.close(); process.exit(0); };
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
