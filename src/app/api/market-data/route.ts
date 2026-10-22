import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { NextResponse } from 'next/server';
import type { Timeframe } from '../../../types/market';

const timeframes: Timeframe[] = ['M1', 'M5', 'M15', 'H1', 'H4'];
const timeframePattern = /(?:^|[._-])(M1|M5|M15|H1|H4)(?:[._-]|$)/i;
const legacyFilenamePattern = /^export_(.+?)\._(M1|M5|M15|H1|H4)_.+\.csv$/i;

type FileCandidate = { timeframe: Timeframe; name: string; modifiedAt: number };
type SymbolFiles = Partial<Record<Timeframe, string>>;

async function scanCsvFiles(directory: string) {
  const names = await readdir(directory, { withFileTypes: true });
  return Promise.all(names.filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.csv')).map(async (entry) => {
    const match = timeframePattern.exec(entry.name);
    if (!match) return null;
    const details = await stat(path.join(directory, entry.name));
    return { timeframe: match[1].toUpperCase() as Timeframe, name: entry.name, modifiedAt: details.mtimeMs } satisfies FileCandidate;
  }));
}

function newestFiles(candidates: FileCandidate[], folderName: string) {
  const files: SymbolFiles = {};
  for (const timeframe of timeframes) {
    const newest = candidates
      .filter((candidate) => candidate.timeframe === timeframe)
      .sort((a, b) => b.modifiedAt - a.modifiedAt)[0];
    if (newest) files[timeframe] = `/data/${encodeURIComponent(folderName)}/${encodeURIComponent(newest.name)}`;
  }
  return files;
}

export async function GET() {
  const dataDirectory = path.join(process.cwd(), 'public', 'data');

  try {
    const entries = await readdir(dataDirectory, { withFileTypes: true });
    const folders = entries.filter((entry) => entry.isDirectory());
    const symbolFiles: Record<string, SymbolFiles> = {};

    await Promise.all(folders.map(async (folder) => {
      const candidates = (await scanCsvFiles(path.join(dataDirectory, folder.name)))
        .filter((candidate): candidate is FileCandidate => candidate !== null);
      const files = newestFiles(candidates, folder.name);
      if (Object.keys(files).length > 0) symbolFiles[folder.name] = files;
    }));

    // Continue to support the earlier layout where exports were placed directly in public/data.
    const rootCandidates = (await scanCsvFiles(dataDirectory))
      .filter((candidate): candidate is FileCandidate => candidate !== null);
    const rootFilesBySymbol = new Map<string, FileCandidate[]>();
    for (const candidate of rootCandidates) {
      const match = legacyFilenamePattern.exec(candidate.name);
      if (!match) continue;
      const symbol = match[1];
      const canonicalSymbol = Object.keys(symbolFiles).find((name) => name.toLowerCase() === symbol.toLowerCase()) ?? symbol;
      const candidates = rootFilesBySymbol.get(canonicalSymbol) ?? [];
      candidates.push(candidate);
      rootFilesBySymbol.set(canonicalSymbol, candidates);
    }
    for (const [symbol, candidates] of rootFilesBySymbol) {
      const files = symbolFiles[symbol] ?? {};
      for (const timeframe of timeframes) {
        if (files[timeframe]) continue;
        const newest = candidates
          .filter((candidate) => candidate.timeframe === timeframe)
          .sort((a, b) => b.modifiedAt - a.modifiedAt)[0];
        if (newest) files[timeframe] = `/data/${encodeURIComponent(newest.name)}`;
      }
      symbolFiles[symbol] = files;
    }

    const symbols = Object.keys(symbolFiles).sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
    return NextResponse.json({ symbols, files: symbolFiles }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    console.error('Could not scan the bundled market-data directory', error);
    return NextResponse.json({ error: 'Market-data directory is unavailable.' }, { status: 500 });
  }
}
