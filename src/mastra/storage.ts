import { existsSync } from 'node:fs';
import path from 'node:path';
import { LibSQLStore } from '@mastra/libsql';

// `mastra dev` and `mastra start` run from different working directories, so a
// relative `file:` URL lands in different places. Anchor on the project root.
function projectRoot(): string {
  let dir = process.cwd();
  while (true) {
    if (existsSync(path.join(dir, 'package.json')) && !dir.includes(`${path.sep}.mastra${path.sep}`)) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return process.cwd();
    dir = parent;
  }
}

export const storage = new LibSQLStore({
  id: 'ivf-companion-storage',
  url: process.env.DATABASE_URL ?? `file:${path.join(projectRoot(), 'mastra.db')}`,
});
