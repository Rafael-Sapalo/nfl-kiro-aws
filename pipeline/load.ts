import { join } from 'node:path';
import { num, readCsv } from './csv.ts';
import type { Pos } from '../shared/types.ts';

export type Align = 'OUT' | 'SLOT' | 'TE' | 'BACK' | 'OTHER';

export interface Game {
  gameId: number;
  week: number;
  home: string;
  visitor: string;
}

export interface PlayInfo {
  gameId: number;
  playId: number;
  description: string;
  quarter: number;
  down: number;
  yardsToGo: number;
  offense: string;
  defense: string;
  passResult: string;
  coverage: string;
  coverageType: string;
  /** "J.Smith-Schuster" style name parsed from the play description, lower-cased. */
  targetAbbr: string | null;
}

export interface Player {
  nflId: number;
  name: string;
  officialPos: string;
  pos: Pos | null;
  abbr: string;
}

export interface RouteRunner {
  nflId: number;
  lined: string;
  align: Align;
}

export interface PlayRoles {
  routes: RouteRunner[];
  coverage: number[];
  rushers: number[];
  /** Any pass rusher credited with a hit, hurry or sack (PFF). */
  pressure: boolean;
}

export const playKey = (gameId: number, playId: number): string => `${gameId}-${playId}`;

export function alignGroup(lined: string): Align {
  if (lined === 'LWR' || lined === 'RWR') return 'OUT';
  if (lined.startsWith('S') && lined.endsWith('WR')) return 'SLOT';
  if (lined.startsWith('TE')) return 'TE';
  if (lined.startsWith('HB') || lined.startsWith('FB')) return 'BACK';
  return 'OTHER';
}

/** "JuJu Smith-Schuster" -> "j.smith-schuster" (matches the play-by-play naming style). */
export function abbreviate(displayName: string): string {
  const parts = displayName.trim().split(/\s+/);
  return `${parts[0][0]}.${parts.slice(1).join('')}`.toLowerCase();
}

const TARGET_RX = /\bto ([A-Z]\.[A-Za-z'\-.]+)/;

export function parseTarget(description: string): string | null {
  const m = TARGET_RX.exec(description);
  return m ? m[1].replace(/\.+$/, '').toLowerCase() : null;
}

function toPos(officialPos: string): Pos | null {
  if (officialPos === 'WR') return 'WR';
  if (officialPos === 'TE') return 'TE';
  if (officialPos === 'RB' || officialPos === 'FB') return 'RB';
  return null;
}

export interface Dataset {
  games: Map<number, Game>;
  plays: Map<string, PlayInfo>;
  players: Map<number, Player>;
  roles: Map<string, PlayRoles>;
}

export function loadDataset(dataDir: string): Dataset {
  const games = new Map<number, Game>();
  for (const r of readCsv(join(dataDir, 'games.csv'))) {
    const gameId = Number(r.gameId);
    games.set(gameId, { gameId, week: Number(r.week), home: r.homeTeamAbbr, visitor: r.visitorTeamAbbr });
  }

  const plays = new Map<string, PlayInfo>();
  for (const r of readCsv(join(dataDir, 'plays.csv'))) {
    const gameId = Number(r.gameId);
    const playId = Number(r.playId);
    plays.set(playKey(gameId, playId), {
      gameId,
      playId,
      description: r.playDescription,
      quarter: num(r.quarter) ?? 0,
      down: num(r.down) ?? 0,
      yardsToGo: num(r.yardsToGo) ?? 0,
      offense: r.possessionTeam,
      defense: r.defensiveTeam,
      passResult: r.passResult === 'NA' ? '' : r.passResult,
      coverage: r.pff_passCoverage === 'NA' ? '' : r.pff_passCoverage,
      coverageType: r.pff_passCoverageType === 'NA' ? 'Other' : r.pff_passCoverageType,
      targetAbbr: parseTarget(r.playDescription),
    });
  }

  const players = new Map<number, Player>();
  for (const r of readCsv(join(dataDir, 'players.csv'))) {
    const nflId = Number(r.nflId);
    players.set(nflId, {
      nflId,
      name: r.displayName,
      officialPos: r.officialPosition,
      pos: toPos(r.officialPosition),
      abbr: abbreviate(r.displayName),
    });
  }

  const roles = new Map<string, PlayRoles>();
  for (const r of readCsv(join(dataDir, 'pffScoutingData.csv'))) {
    const key = playKey(Number(r.gameId), Number(r.playId));
    let pr = roles.get(key);
    if (!pr) {
      pr = { routes: [], coverage: [], rushers: [], pressure: false };
      roles.set(key, pr);
    }
    const nflId = Number(r.nflId);
    if (r.pff_role === 'Pass Route') {
      pr.routes.push({ nflId, lined: r.pff_positionLinedUp, align: alignGroup(r.pff_positionLinedUp) });
    } else if (r.pff_role === 'Coverage') {
      pr.coverage.push(nflId);
    } else if (r.pff_role === 'Pass Rush') {
      pr.rushers.push(nflId);
      if (r.pff_hit === '1' || r.pff_hurry === '1' || r.pff_sack === '1') pr.pressure = true;
    }
  }

  return { games, plays, players, roles };
}
