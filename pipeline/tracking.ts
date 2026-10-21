import { readFileSync } from 'node:fs';

/** One entity's path through a play. Arrays are indexed by frameId (1-based); missing frames are undefined. */
export interface Track {
  nflId: number | null;
  team: string;
  jersey: number | null;
  x: number[];
  y: number[];
}

export interface PlayTrack {
  playId: number;
  nFrames: number;
  tracks: Map<number, Track>;
  ball: Track | null;
  /** frameId -> event tag (ball_snap, pass_forward, ...). */
  events: Map<number, string>;
}

const FIELD_LENGTH = 120;
const FIELD_WIDTH = 53.3;

/**
 * Reads one tracking_[gameId].csv. The files contain no quoted fields, so a plain split is safe and fast.
 * Coordinates are normalised so the offense always moves left -> right.
 * Columns: gameId,playId,nflId,frameId,time,jerseyNumber,team,playDirection,x,y,s,a,dis,o,dir,event
 */
export function readGameTracking(path: string): Map<number, PlayTrack> {
  const text = readFileSync(path, 'utf8');
  const plays = new Map<number, PlayTrack>();
  let pos = text.indexOf('\n') + 1;
  while (pos < text.length) {
    let end = text.indexOf('\n', pos);
    if (end === -1) end = text.length;
    const line = text.slice(pos, end);
    pos = end + 1;
    if (line.length < 10) continue;
    const c = line.split(',');
    const playId = Number(c[1]);
    const frame = Number(c[3]);
    let pt = plays.get(playId);
    if (!pt) {
      pt = { playId, nFrames: 0, tracks: new Map(), ball: null, events: new Map() };
      plays.set(playId, pt);
    }
    if (frame > pt.nFrames) pt.nFrames = frame;

    let x = Number(c[8]);
    let y = Number(c[9]);
    if (c[7] === 'left') {
      x = FIELD_LENGTH - x;
      y = FIELD_WIDTH - y;
    }

    let track: Track | undefined;
    if (c[2] === 'NA') {
      if (!pt.ball) pt.ball = { nflId: null, team: 'football', jersey: null, x: [], y: [] };
      track = pt.ball;
    } else {
      const nflId = Number(c[2]);
      track = pt.tracks.get(nflId);
      if (!track) {
        track = { nflId, team: c[6], jersey: c[5] === 'NA' ? null : Number(c[5]), x: [], y: [] };
        pt.tracks.set(nflId, track);
      }
    }
    track.x[frame] = x;
    track.y[frame] = y;

    let ev = c[15] ?? '';
    if (ev.endsWith('\r')) ev = ev.slice(0, -1);
    if (ev !== '' && ev !== 'None' && ev !== 'NA' && !pt.events.has(frame)) pt.events.set(frame, ev);
  }
  return plays;
}
