declare interface Fetcher {
  fetch(input: Request): Promise<Response>;
}

declare interface D1Database {}

declare module "cloudflare:workers" {
  export const env: Record<string, any>;
}
