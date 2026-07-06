// js-yaml ships without bundled type declarations; only `load` is used here.
declare module "js-yaml" {
  export function load(content: string): unknown
}
