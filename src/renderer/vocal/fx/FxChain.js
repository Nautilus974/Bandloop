// Chaîne d'effets temps réel d'une piste : input → effet 1 → effet 2 → … → output.
// Si seuls des paramètres changent, on les applique en place (pas de coupure) ;
// si la structure change (ajout, retrait, ordre, activation), on recâble.
import { createFxNode } from './nodes.js';

export class FxChain {
  constructor(ctx) {
    this.ctx = ctx;
    this.input = ctx.createGain();
    this.output = ctx.createGain();
    this.nodes = [];
    this.signature = '';
    this.input.connect(this.output);
  }

  /** @param {Array<{id: string, type: string, enabled: boolean, params: object}>} chain */
  apply(chain) {
    const active = chain.filter((m) => m.enabled);
    const signature = active.map((m) => `${m.id}:${m.type}`).join('|');
    if (signature === this.signature) {
      active.forEach((m, i) => this.nodes[i].set(m.params));
      return;
    }
    this.signature = signature;
    this.input.disconnect();
    for (const node of this.nodes) node.dispose();
    this.nodes = active.map((m) => createFxNode(this.ctx, m));
    let previous = this.input;
    for (const node of this.nodes) {
      previous.connect(node.input);
      previous = node.output;
    }
    previous.connect(this.output);
  }

  dispose() {
    for (const node of this.nodes) node.dispose();
    this.input.disconnect();
    this.output.disconnect();
  }
}
