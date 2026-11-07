import { UserService } from "@reqvia/example-domain";
import { createFetchTransport } from "@reqvia/transport-fetch";
import { createHttpClient } from "reqvia";

export const users = new UserService(
  createHttpClient({
    baseURL: new URL("/api/", location.origin).href,
    timeoutMs: 5_000,
    transport: createFetchTransport({ fetch, createAbortController: () => new AbortController() }),
  }),
);
