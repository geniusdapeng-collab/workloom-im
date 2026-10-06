/** The minimal connect/Vite middleware surface the identity hook actually calls. */
export interface WorkLoomViteMiddleware {
  use(handler: (request: unknown, response: { setHeader(name: string, value: string): void }, next: () => void) => void): void;
}

export interface WorkLoomViteDevServer {
  middlewares: WorkLoomViteMiddleware;
}

export interface WorkLoomViteProduct {
  readonly define: Readonly<Record<string, string>>;
  readonly plugin: {
    readonly name: string;
    configureServer(server: WorkLoomViteDevServer): void;
    configurePreviewServer(server: WorkLoomViteDevServer): void;
    transformIndexHtml(html: string): string;
  };
}

export function workloomProductVite(clientLabel: string): WorkLoomViteProduct;
