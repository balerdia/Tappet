/**
 * What the connected systems can do, as far as the workflow layer needs to know.
 * The connectors package builds this from connector manifests; validation and
 * sentence rendering read it. Keeping it here means the workflow core has no
 * dependency on any particular connector.
 */
export type CatalogEntry = {
  connector: string;
  name: string;
  kind: "event" | "action";
  /** Readable phrase used in sentences, e.g. "someone submits a contact form". */
  phrase: string;
  /** Sensitive actions (sending email, deleting, paying) must sit behind an approval. */
  sensitive?: boolean;
  requiredInputs?: string[];
};

export type Catalog = {
  find(connector: string, name: string, kind: CatalogEntry["kind"]): CatalogEntry | undefined;
};

export function createCatalog(entries: CatalogEntry[]): Catalog {
  const byKey = new Map(entries.map((e) => [`${e.kind}:${e.connector}:${e.name}`, e]));
  return {
    find: (connector, name, kind) => byKey.get(`${kind}:${connector}:${name}`),
  };
}
