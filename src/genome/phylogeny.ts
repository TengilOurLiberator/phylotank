/**
 * The pruned individual phylogeny (01 §1.9.5): the ancestry of everything alive.
 *
 * - On birth a node is added and the mother's descendant count rises; the father is recorded
 *   but the tree follows the mother line, so it stays a tree.
 * - On death a node with no living descendants is deleted, cascading up the mother line.
 * - Unary chains (an ancestor with exactly one surviving child line) are coalesced lazily by
 *   `compact()`, which splices dead single-child nodes out and adds their edge length to the
 *   child (`generations` counts the births an edge stands for).
 * - `mrca(a, b)` walks up from both, O(depth).
 * Ids are entity ids (numbers below 2^53). Nodes live in a Map used for lookups only; nothing
 * iterates it to produce sim results (CONTRACT 4.2 rule 8), and this is host-side state anyway.
 */
export interface PhyloNode {
  id: number; mother: number; father: number; birthTick: number; species: number;
  alive: boolean; children: number; generations: number;
}

export class Phylogeny {
  private readonly nodes = new Map<number, PhyloNode>();
  get size(): number { return this.nodes.size; }
  get(id: number): PhyloNode | undefined { return this.nodes.get(id); }

  /** Record a birth. `mother` 0 means a founder (designed or seeded). */
  birth(id: number, mother: number, father: number, birthTick: number, species: number): void {
    const m = this.nodes.get(mother);
    if (m) m.children++;
    this.nodes.set(id, {
      id, mother: m ? mother : 0, father, birthTick, species, alive: true, children: 0, generations: 1,
    });
  }

  death(id: number): void {
    const n = this.nodes.get(id);
    if (!n) return;
    n.alive = false;
    this.prune(n);
  }

  private prune(start: PhyloNode): void {
    let n: PhyloNode | undefined = start;
    while (n && !n.alive && n.children === 0) {
      this.nodes.delete(n.id);
      const m = this.nodes.get(n.mother);
      if (m) m.children--;
      n = m;
    }
  }

  /** Most recent common ancestor of two nodes, themselves included (0 if none: different founders). */
  mrca(a: number, b: number): number {
    const seen = new Set<number>();
    for (let n = this.nodes.get(a); n; n = this.nodes.get(n.mother)) seen.add(n.id);
    for (let n = this.nodes.get(b); n; n = this.nodes.get(n.mother)) if (seen.has(n.id)) return n.id;
    return 0;
  }

  /** Ancestors of a node, nearest first (for "how related are these two?"). */
  ancestors(id: number): number[] {
    const out: number[] = [];
    let n = this.nodes.get(this.nodes.get(id)?.mother ?? 0);
    while (n) { out.push(n.id); n = this.nodes.get(n.mother); }
    return out;
  }

  /**
   * Coalesce unary chains: a dead node with exactly one child is spliced out and the child's
   * edge stands for both. `ids` lists the nodes to consider (the caller passes the children of
   * recent deaths, or every node in ascending id order on a save).
   */
  compact(ids: readonly number[]): number {
    let spliced = 0;
    for (const id of ids) {
      const n = this.nodes.get(id);
      if (!n) continue;
      let m = this.nodes.get(n.mother);
      while (m && !m.alive && m.children === 1) {
        // splice m out: n now hangs from m's mother, and its edge stands for both
        n.mother = m.mother;
        n.generations += m.generations;
        this.nodes.delete(m.id);
        spliced++;
        m = this.nodes.get(n.mother);
      }
    }
    return spliced;
  }
}
