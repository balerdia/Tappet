// The pieces ship as plain JavaScript; we only rely on the shape in adapter.ts.
declare module "@activepieces/piece-gmail" {
  export const gmail: import("./adapter.js").Piece;
}
declare module "@activepieces/piece-google-drive" {
  export const googleDrive: import("./adapter.js").Piece;
}
