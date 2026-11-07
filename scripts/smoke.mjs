#!/usr/bin/env node
/**
 * Manual smoke probe: prints real `host_stats` and `ports_list` JSON.
 *
 * This is intentionally not part of CI: it reads the actual host and may be
 * limited when run from a sandboxed shell (Windows CIM probes fail closed, and
 * the tool explains that in `notes` instead of throwing). It requires no
 * devices, emulators, or admin rights.
 */

import { createCommandRunner } from '../lib/command.js';
import { createHostService } from '../lib/service.js';
import { createProcessControl } from '../lib/kill.js';
import { createProbes } from '../lib/probes.js';
import { createNodeSystem } from '../lib/system.js';

const commandRunner = createCommandRunner({});
const probes = createProbes({ commandRunner, platform: process.platform });
const system = createNodeSystem({});
const control = createProcessControl({});
const service = createHostService({ system, probes, control });

const stats = await service.hostStats({ includeGpu: true });
const ports = await service.portsList({ ports: [8787, 5173] });

console.log(JSON.stringify({ hostStats: stats, portsList: ports }, null, 2));
