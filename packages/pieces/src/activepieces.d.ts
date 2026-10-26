// Activepieces publishes pieces as bundled JavaScript without type
// declarations. This is the small part of their shape we rely on.

declare module "@activepieces/piece-linear" {
  export const linear: {
    actions(): Record<
      string,
      {
        props: Record<string, { required?: boolean }>;
        run(context: unknown): Promise<unknown>;
      }
    >;
  };
}
