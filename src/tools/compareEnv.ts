import { parseEnvFile, diffEnvFiles, EnvDiffEntry } from "../lib/env.js";

export interface CompareEnvInput {
  files: string[];
}

export interface CompareEnvResult {
  filesCompared: string[];
  missingKeys: Array<{ key: string; missingIn: string[]; secretLike: boolean }>;
  emptyKeys: Array<{ key: string; emptyIn: string[]; secretLike: boolean }>;
  divergentValues: Array<{ key: string; secretLike: boolean }>;
  onlyInOne: Array<{ key: string; presentIn: string; secretLike: boolean }>;
  totalKeys: number;
  detail: EnvDiffEntry[];
}

export async function compareEnv(input: CompareEnvInput): Promise<CompareEnvResult> {
  const { files } = input;
  if (!files || files.length < 2) {
    throw new Error("compare_env requires at least 2 files.");
  }
  const parsed = await Promise.all(files.map(parseEnvFile));
  const detail = diffEnvFiles(parsed);

  const missingKeys: CompareEnvResult["missingKeys"] = [];
  const emptyKeys: CompareEnvResult["emptyKeys"] = [];
  const divergentValues: CompareEnvResult["divergentValues"] = [];
  const onlyInOne: CompareEnvResult["onlyInOne"] = [];

  for (const d of detail) {
    const missingIn: string[] = [];
    const emptyIn: string[] = [];
    const presentIn: string[] = [];
    for (const [path, state] of Object.entries(d.presence)) {
      if (state === "missing") missingIn.push(path);
      else if (state === "empty") emptyIn.push(path);
      else presentIn.push(path);
    }
    if (missingIn.length > 0 && missingIn.length < files.length) {
      missingKeys.push({ key: d.key, missingIn, secretLike: d.secretLike });
    }
    if (emptyIn.length > 0) {
      emptyKeys.push({ key: d.key, emptyIn, secretLike: d.secretLike });
    }
    if (d.valueDiverges) {
      divergentValues.push({ key: d.key, secretLike: d.secretLike });
    }
    if (presentIn.length === 1 && files.length > 1) {
      onlyInOne.push({ key: d.key, presentIn: presentIn[0], secretLike: d.secretLike });
    }
  }

  return {
    filesCompared: files,
    missingKeys,
    emptyKeys,
    divergentValues,
    onlyInOne,
    totalKeys: detail.length,
    detail,
  };
}
