import { BaseSequencer, type TestSpecification } from "vitest/node";

// Vitest groups projects sequentially. Interleave their ordered files so the slow process
// lifecycle tests overlap PostgreSQL work on the same four workers.
export class ParallelSequencer extends BaseSequencer {
  override async sort(files: TestSpecification[]): Promise<TestSpecification[]> {
    const projects = new Map<string, TestSpecification[]>();
    for (const file of await super.sort(files)) {
      const queue = projects.get(file.project.name) ?? [];
      queue.push(file);
      projects.set(file.project.name, queue);
    }
    const ordered: TestSpecification[] = [];
    while (projects.size > 0) {
      for (const [name, queue] of projects) {
        const next = queue.shift();
        if (next !== undefined) ordered.push(next);
        if (queue.length === 0) projects.delete(name);
      }
    }
    return ordered;
  }
}
