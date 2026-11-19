import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ProjectContext } from '../types/index.js';

export interface ProjectManifest {
  projectId: string;
  name: string;
  createdAt: string;
  storageProvider?: 'local' | 'supabase';
}

const EASYBRAIN_DIR = '.easybrain';
const MANIFEST_FILE = 'project.json';
const LOCAL_DB_FILE = 'memory.json';

/**
 * ProjectResolver:
 * Resolves a stable, isolated projectId and local storage path for any repository.
 * Walks up parent directories to respect monorepos/subdirectories without creating
 * fragmented databases, and never guesses blindly when no path is provided.
 */
export class ProjectResolver {
  /**
   * Walks up from startPath looking for an existing .easybrain/project.json.
   */
  static findExistingRoot(startPath: string): string | null {
    let current = path.resolve(startPath);
    const root = path.parse(current).root;

    while (true) {
      const candidate = path.join(current, EASYBRAIN_DIR, MANIFEST_FILE);
      if (fs.existsSync(candidate)) {
        return current;
      }
      if (current === root) {
        return null;
      }
      current = path.dirname(current);
    }
  }

  /**
   * Resolves or initializes a project context for a given directory path.
   */
  static resolveFromPath(
    projectPath: string,
    options?: { autoInit?: boolean; sessionId?: string; clientId?: string }
  ): ProjectContext & { localDbPath: string } {
    if (!projectPath || !projectPath.trim()) {
      throw new Error(
        'Project path is required to resolve an isolated project scope.'
      );
    }

    const resolvedInput = path.resolve(projectPath);
    const existingRoot = this.findExistingRoot(resolvedInput);
    const rootPath = existingRoot || resolvedInput;
    const easybrainDir = path.join(rootPath, EASYBRAIN_DIR);
    const manifestPath = path.join(easybrainDir, MANIFEST_FILE);
    const localDbPath = path.join(easybrainDir, LOCAL_DB_FILE);

    if (fs.existsSync(manifestPath)) {
      const raw = fs.readFileSync(manifestPath, 'utf-8');
      const manifest = JSON.parse(raw) as ProjectManifest;
      if (!manifest.projectId) {
        throw new Error(`Invalid EasyBrain manifest at ${manifestPath}: missing projectId.`);
      }
      return {
        projectId: manifest.projectId,
        rootPath,
        sessionId: options?.sessionId,
        clientId: options?.clientId,
        localDbPath,
      };
    }

    if (options?.autoInit === false) {
      throw new Error(
        `No EasyBrain project found at ${rootPath}. Run "easybrain init --project ${rootPath}" first.`
      );
    }

    // Initialize .easybrain/project.json for this repository
    fs.mkdirSync(easybrainDir, { recursive: true });
    const manifest: ProjectManifest = {
      projectId: crypto.randomUUID(),
      name: path.basename(rootPath),
      createdAt: new Date().toISOString(),
    };
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8');

    return {
      projectId: manifest.projectId,
      rootPath,
      sessionId: options?.sessionId,
      clientId: options?.clientId,
      localDbPath,
    };
  }
}
