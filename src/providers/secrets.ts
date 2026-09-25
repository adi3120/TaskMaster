import fs from "node:fs/promises";
import path from "node:path";

const REF_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

export interface SecretStore {
  put(ref: string, value: string): Promise<void>;
  get(ref: string): Promise<string | null>;
  delete(ref: string): Promise<void>;
}

export class FileSecretStore implements SecretStore {
  constructor(private readonly directory: string) {}

  async put(ref: string, value: string): Promise<void> {
    const file = this.fileFor(ref);
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    await fs.chmod(this.directory, 0o700);
    await fs.writeFile(file, value, { mode: 0o600 });
    await fs.chmod(file, 0o600);
  }

  async get(ref: string): Promise<string | null> {
    try {
      return await fs.readFile(this.fileFor(ref), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async delete(ref: string): Promise<void> {
    await fs.rm(this.fileFor(ref), { force: true });
  }

  private fileFor(ref: string): string {
    if (!REF_PATTERN.test(ref)) {
      throw new Error(`Secret ref "${ref}" must match ${REF_PATTERN.source}`);
    }
    return path.join(this.directory, ref);
  }
}
