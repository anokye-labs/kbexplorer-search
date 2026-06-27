/** Minimal type declarations for the optional faiss-node dependency. */
declare module 'faiss-node' {
  export class IndexFlatIP {
    constructor(dimensions: number);
    add(vector: number[]): void;
    search(query: number[], k: number): { distances: number[]; labels: number[] };
    ntotal(): number;
  }
}
