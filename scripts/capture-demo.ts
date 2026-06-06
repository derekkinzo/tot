#!/usr/bin/env npx tsx
/**
 * Captures a sequence of screenshots showing the tot-mcp tree visualization
 * being built step by step. Output: docs/frames/frame_NNN.png
 *
 * Prerequisites:
 *   - Build the project first: npm run build
 *   - No other daemon running on port 6274 (run `tot-mcp stop` first)
 *
 * After running this, convert to GIF:
 *   ffmpeg -framerate 4 -i docs/frames/frame_%03d.png \
 *     -vf "fps=4,scale=900:-1:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=128[p];[s1][p]paletteuse=dither=bayer" \
 *     -loop 0 docs/demo.gif
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const FRAMES_DIR = join(process.cwd(), 'docs', 'frames');
const WIDTH = 900;
const HEIGHT = 600;
const SERVER_PATH = join(process.cwd(), 'packages/server/dist/cli.js');
const PROJECT_DIR = '/tmp/tot-demo-capture-project';
const PORT = 6274;

let frameNum = 0;

async function main() {
  rmSync(FRAMES_DIR, { recursive: true, force: true });
  mkdirSync(FRAMES_DIR, { recursive: true });
  rmSync(PROJECT_DIR, { recursive: true, force: true });
  mkdirSync(join(PROJECT_DIR, '.tot', 'sessions'), { recursive: true });

  // Stop any existing daemon
  const stop = spawn('node', [SERVER_PATH, 'stop'], { stdio: 'pipe' });
  await new Promise<void>((r) => stop.on('close', () => r()));
  await sleep(500);

  // Start the shim (which auto-starts daemon on default port 6274)
  const shim = spawn('node', [SERVER_PATH], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, CLAUDE_PROJECT_DIR: PROJECT_DIR },
  });

  let buffer = '';
  const pending = new Map<number, (v: any) => void>();
  let nextId = 1;

  shim.stdout!.on('data', (data: Buffer) => {
    buffer += data.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);
        if ('id' in msg && pending.has(msg.id)) {
          pending.get(msg.id)!(msg);
          pending.delete(msg.id);
        }
      } catch {}
    }
  });

  // Wait for daemon to become ready
  await new Promise<void>((resolve) => {
    shim.stderr!.on('data', (d: Buffer) => {
      const text = d.toString();
      if (text.includes('Handshake confirmed') || text.includes('HTTP') || text.includes('Visualization')) resolve();
    });
    setTimeout(resolve, 6000);
  });

  // Initialize MCP
  await send('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'capture', version: '1.0' } });
  shim.stdin!.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  await sleep(1000);

  // Launch browser
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT } });
  await page.goto(`http://localhost:${PORT}`);
  await sleep(2000);

  // Dismiss legend
  await page.evaluate(() => {
    const btns = document.querySelectorAll('button');
    for (const b of btns) { if (b.textContent?.trim() === '×') { b.click(); break; } }
  });
  await sleep(500);

  // Frame 1: Empty state
  await capture(page);

  // Create tree
  await callTool('create_tree', { problem: 'Production API returning 502 errors for 15% of requests since deploy' });
  await sleep(1500);
  await capture(page);

  // Decompose into L1 hypotheses
  const decomp = await callTool('decompose', { parentId: await getRootId(), children: ['Backend service unhealthy', 'Config change broke routing', 'Network/TLS issue', 'Resource exhaustion'] });
  await sleep(1500);
  await capture(page);

  // Add evidence + eliminate some L1 hypotheses
  const ids = decomp.childIds;
  await callTool('add_evidence', { hypothesisId: ids[0], type: 'refutes', content: 'Backends healthy when called directly' });
  await callTool('eliminate_hypothesis', { hypothesisId: ids[0], reason: 'Backends confirmed healthy' });
  await sleep(1000);
  await capture(page);

  await callTool('add_evidence', { hypothesisId: ids[2], type: 'refutes', content: 'Only modified routes fail' });
  await callTool('eliminate_hypothesis', { hypothesisId: ids[2], reason: 'Route-specific, not network' });
  await callTool('add_evidence', { hypothesisId: ids[3], type: 'refutes', content: 'Metrics normal' });
  await callTool('eliminate_hypothesis', { hypothesisId: ids[3], reason: 'Resource metrics normal' });
  await sleep(1000);
  await capture(page);

  // Score the surviving hypothesis
  await callTool('add_evidence', { hypothesisId: ids[1], type: 'supports', content: 'Errors correlate with modified routes' });
  await callTool('score_hypothesis', { hypothesisId: ids[1], score: 0.85 });
  await sleep(1000);
  await capture(page);

  // Decompose L2: drill into the config change hypothesis
  const decomp2 = await callTool('decompose', { parentId: ids[1], children: ['Invalid upstream target', 'Timeout too low', 'Health check path wrong'] });
  await sleep(2000);
  await capture(page);

  // Evidence + eliminate at L2, score the winner
  const l2 = decomp2.childIds;
  await callTool('add_evidence', { hypothesisId: l2[2], type: 'supports', content: 'Health check returns 404 on new endpoint' });
  await callTool('score_hypothesis', { hypothesisId: l2[2], score: 0.92 });
  await callTool('add_evidence', { hypothesisId: l2[0], type: 'refutes', content: 'DNS resolves correctly from gateway host' });
  await callTool('eliminate_hypothesis', { hypothesisId: l2[0], reason: 'DNS resolves correctly' });
  await callTool('add_evidence', { hypothesisId: l2[1], type: 'refutes', content: '502 returned in 100ms, well under 30s timeout' });
  await callTool('eliminate_hypothesis', { hypothesisId: l2[1], reason: '502 in 100ms, timeout is 30s' });
  await sleep(1500);
  await capture(page);

  // Corroborate root cause
  await callTool('corroborate_hypothesis', { hypothesisId: l2[2], reason: 'Health endpoint renamed /health → /healthz in v2.1, gateway config not updated' });
  await sleep(1500);
  await capture(page);

  // Hold final frames
  await capture(page);
  await capture(page);

  console.log(`\n✓ Captured ${frameNum} frames in ${FRAMES_DIR}`);
  console.log(`\nTo generate GIF:\n  ffmpeg -framerate 4 -i docs/frames/frame_%03d.png -vf "fps=4,scale=900:-1:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=128[p];[s1][p]paletteuse=dither=bayer" -loop 0 docs/demo.gif`);

  await browser.close();
  shim.stdin!.end();
  process.exit(0);

  // --- Helpers ---

  function send(method: string, params: any): Promise<any> {
    const id = nextId++;
    return new Promise((resolve) => {
      const timeout = setTimeout(() => { pending.delete(id); resolve({}); }, 10000);
      pending.set(id, (v) => { clearTimeout(timeout); resolve(v); });
      shim.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }

  async function callTool(name: string, args: any): Promise<any> {
    const resp = await send('tools/call', { name, arguments: args });
    const text = resp?.result?.content?.find((c: any) => c.type === 'text')?.text || '';
    try { return JSON.parse(text.split('\n')[0]); } catch { return {}; }
  }

  async function getRootId(): Promise<string> {
    const treeResp = await send('tools/call', { name: 'get_tree', arguments: { format: 'full' } });
    const treeText = treeResp?.result?.content?.find((c: any) => c.type === 'text')?.text || '';
    const parsed = JSON.parse(treeText);
    const rootHyp = Object.values(parsed.hypotheses as any).find((h: any) => h.parentId === null) as any;
    return rootHyp?.id || '';
  }
}

async function capture(page: any) {
  await page.keyboard.press('Escape');
  await sleep(800);
  frameNum++;
  const path = join(FRAMES_DIR, `frame_${String(frameNum).padStart(3, '0')}.png`);
  await page.screenshot({ path });
  console.log(`  [${frameNum}] captured`);
}

function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }

main().catch((e) => { console.error(e); process.exit(1); });
