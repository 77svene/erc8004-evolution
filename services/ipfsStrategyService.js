import { create } from 'ipfs-http-client';
import { createHash } from 'crypto';
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';

const DEFAULT_IPFS_URL = 'http://localhost:5001';
const MAX_BYTECODE_SIZE = 500 * 1024; // 500KB limit to prevent DoS
const STRATEGY_REGISTRY_PATH = join(process.cwd(), 'data', 'strategy_registry.json');
const PROVENANCE_CHAIN_PATH = join(process.cwd(), 'data', 'provenance_chain.json');
const PERFORMANCE_METRICS_PATH = join(process.cwd(), 'data', 'performance_metrics.json');

class IPFSStrategyService {
  constructor(ipfsUrl = DEFAULT_IPFS_URL, dataDir = 'data') {
    this.ipfs = create({ url: ipfsUrl });
    this.strategyRegistry = this._loadRegistry();
    this.provenanceChain = this._loadProvenanceChain();
    this.performanceMetrics = this._loadPerformanceMetrics();
    this._ensureDataDirExists();
  }

  _ensureDataDirExists() {
    if (!existsSync('data')) {
      mkdirSync('data', { recursive: true });
    }
  }

  _loadRegistry() {
    try {
      if (existsSync(STRATEGY_REGISTRY_PATH)) {
        return JSON.parse(readFileSync(STRATEGY_REGISTRY_PATH, 'utf8'));
      }
    } catch (e) {
      console.error('Failed to load registry, starting fresh');
    }
    return {};
  }

  _saveRegistry() {
    writeFileSync(STRATEGY_REGISTRY_PATH, JSON.stringify(this.strategyRegistry, null, 2));
  }

  _loadProvenanceChain() {
    try {
      if (existsSync(PROVENANCE_CHAIN_PATH)) {
        return JSON.parse(readFileSync(PROVENANCE_CHAIN_PATH, 'utf8'));
      }
    } catch (e) {
      console.error('Failed to load provenance chain, starting fresh');
    }
    return [];
  }

  _saveProvenanceChain() {
    writeFileSync(PROVENANCE_CHAIN_PATH, JSON.stringify(this.provenanceChain, null, 2));
  }

  _loadPerformanceMetrics() {
    try {
      if (existsSync(PERFORMANCE_METRICS_PATH)) {
        return JSON.parse(readFileSync(PERFORMANCE_METRICS_PATH, 'utf8'));
      }
    } catch (e) {
      console.error('Failed to load performance metrics, starting fresh');
    }
    return {};
  }

  _savePerformanceMetrics() {
    writeFileSync(PERFORMANCE_METRICS_PATH, JSON.stringify(this.performanceMetrics, null, 2));
  }

  _validateBytecode(bytecode) {
    if (!bytecode || typeof bytecode !== 'string') {
      throw new Error('Invalid bytecode: must be a non-empty string');
    }
    const cleanBytecode = bytecode.replace(/^0x/i, '');
    if (cleanBytecode.length % 2 !== 0) {
      throw new Error('Invalid bytecode: must have even length');
    }
    const byteLength = cleanBytecode.length / 2;
    if (byteLength > MAX_BYTECODE_SIZE) {
      throw new Error(`Bytecode exceeds maximum size of ${MAX_BYTECODE_SIZE} bytes`);
    }
    return cleanBytecode;
  }

  _computeHash(data) {
    return createHash('sha256').update(data).digest('hex');
  }

  _computeMerkleRoot(entries) {
    if (entries.length === 0) {
      return this._computeHash('EMPTY');
    }
    if (entries.length === 1) {
      return this._computeHash(entries[0]);
    }
    const leaves = entries.map(entry => this._computeHash(entry));
    while (leaves.length > 1) {
      const nextLevel = [];
      for (let i = 0; i < leaves.length; i += 2) {
        const left = leaves[i];
        const right = leaves[i + 1] || left;
        nextLevel.push(this._computeHash(left + right));
      }
      leaves.length = 0;
      leaves.push(...nextLevel);
    }
    return leaves[0];
  }

  async uploadStrategy(bytecode, metadata = {}) {
    const cleanBytecode = this._validateBytecode(bytecode);
    const timestamp = Date.now();
    const strategyId = this._computeHash(`${cleanBytecode}${timestamp}`);
    const strategyData = {
      bytecode: cleanBytecode,
      metadata,
      timestamp,
      version: this.strategyRegistry[metadata.version] || 1
    };
    const strategyJson = JSON.stringify(strategyData);
    const uploadResult = await this.ipfs.add(Buffer.from(strategyJson));
    const cid = uploadResult.path;
    const merkleEntry = this._computeHash(`${cid}${timestamp}${strategyId}`);
    this.provenanceChain.push({
      strategyId,
      cid,
      merkleHash: merkleEntry,
      timestamp,
      metadata,
      previousHash: this.provenanceChain.length > 0 ? this.provenanceChain[this.provenanceChain.length - 1].merkleHash : 'GENESIS'
    });
    this.strategyRegistry[strategyId] = {
      cid,
      version: metadata.version || 1,
      timestamp,
      metadata,
      isActive: false
    };
    this._saveRegistry();
    this._saveProvenanceChain();
    return {
      cid,
      strategyId,
      merkleRoot: this._computeMerkleRoot(this.provenanceChain.map(e => e.merkleHash)),
      provenanceIndex: this.provenanceChain.length - 1
    };
  }

  async getStrategy(cid) {
    try {
      const result = await this.ipfs.cat(cid);
      const strategyData = JSON.parse(result.toString());
      const strategyId = this._computeHash(`${strategyData.bytecode}${strategyData.timestamp}`);
      const provenanceEntry = this.provenanceChain.find(e => e.cid === cid);
      if (!provenanceEntry) {
        throw new Error('Strategy not found in provenance chain');
      }
      return {
        ...strategyData,
        strategyId,
        provenanceEntry,
        merkleProof: this._generateMerkleProof(provenanceEntry.merkleHash)
      };
    } catch (e) {
      if (e.message.includes('not found')) {
        throw new Error('VERSION_NOT_FOUND');
      }
      throw e;
    }
  }

  _generateMerkleProof(merkleHash) {
    const index = this.provenanceChain.findIndex(e => e.merkleHash === merkleHash);
    if (index === -1) {
      throw new Error('Hash not found in provenance chain');
    }
    const leaves = this.provenanceChain.map(e => e.merkleHash);
    const proof = [];
    let current = index;
    while (leaves.length > 1) {
      const siblingIndex = current % 2 === 0 ? current + 1 : current - 1;
      if (siblingIndex < leaves.length) {
        proof.push({
          hash: leaves[siblingIndex],
          position: current % 2 === 0 ? 'right' : 'left'
        });
      }
      const nextLevel = [];
      for (let i = 0; i < leaves.length; i += 2) {
        const left = leaves[i];
        const right = leaves[i + 1] || left;
        nextLevel.push(this._computeHash(left + right));
      }
      leaves.length = 0;
      leaves.push(...nextLevel);
      current = Math.floor(current / 2);
    }
    return {
      root: leaves[0],
      proof,
      index
    };
  }

  async verifyProvenance(cid, merkleProof) {
    const strategyData = await this.getStrategy(cid);
    const computedRoot = this._computeMerkleRoot(this.provenanceChain.map(e => e.merkleHash));
    let currentHash = strategyData.provenanceEntry.merkleHash;
    for (const step of merkleProof.proof) {
      if (step.position === 'left') {
        currentHash = this._computeHash(step.hash + currentHash);
      } else {
        currentHash = this._computeHash(currentHash + step.hash);
      }
    }
    return currentHash === merkleProof.root;
  }

  async getActiveStrategy() {
    const active = Object.values(this.strategyRegistry).find(s => s.isActive);
    if (!active) {
      throw new Error('NO_ACTIVE_STRATEGY');
    }
    return this.getStrategy(active.cid);
  }

  async setActiveStrategy(strategyId) {
    if (!this.strategyRegistry[strategyId]) {
      throw new Error('STRATEGY_NOT_FOUND');
    }
    const previousActive = Object.entries(this.strategyRegistry).find(([_, s]) => s.isActive);
    if (previousActive) {
      this.strategyRegistry[previousActive[0]].isActive = false;
    }
    this.strategyRegistry[strategyId].isActive = true;
    this.strategyRegistry[strategyId].activatedAt = Date.now();
    this._saveRegistry();
    return {
      previousActive: previousActive ? previousActive[0] : null,
      newActive: strategyId
    };
  }

  async getStrategyHistory() {
    return this.provenanceChain.map((entry, index) => ({
      ...entry,
      merkleRoot: this._computeMerkleRoot(this.provenanceChain.slice(0, index + 1).map(e => e.merkleHash)),
      isActive: this.strategyRegistry[entry.strategyId]?.isActive || false
    }));
  }

  async recordPerformance(strategyId, metrics) {
    if (!this.strategyRegistry[strategyId]) {
      throw new Error('STRATEGY_NOT_FOUND');
    }
    const timestamp = Date.now();
    this.performanceMetrics[strategyId] = {
      ...this.performanceMetrics[strategyId],
      [timestamp]: metrics
    };
    this._savePerformanceMetrics();
    return {
      strategyId,
      timestamp,
      metrics
    };
  }

  async getPerformanceHistory(strategyId) {
    if (!this.performanceMetrics[strategyId]) {
      return [];
    }
    return Object.entries(this.performanceMetrics[strategyId])
      .map(([timestamp, metrics]) => ({
        timestamp: parseInt(timestamp),
        ...metrics
      }))
      .sort((a, b) => a.timestamp - b.timestamp);
  }

  async getStrategyVersion(strategyId) {
    if (!this.strategyRegistry[strategyId]) {
      throw new Error('STRATEGY_NOT_FOUND');
    }
    return this.strategyRegistry[strategyId].version;
  }

  async rollbackToVersion(strategyId, version) {
    const history = this.provenanceChain.filter(e => e.strategyId === strategyId);
    const targetEntry = history.find(e => e.metadata.version === version);
    if (!targetEntry) {
      throw new Error('VERSION_NOT_FOUND');
    }
    return this.setActiveStrategy(strategyId);
  }

  async getProvenanceRoot() {
    return this._computeMerkleRoot(this.provenanceChain.map(e => e.merkleHash));
  }

  async getRegistrySnapshot() {
    return {
      strategies: this.strategyRegistry,
      provenanceRoot: this.getProvenanceRoot(),
      timestamp: Date.now()
    };
  }

  async verifyStrategyIntegrity(cid, expectedHash) {
    const strategyData = await this.getStrategy(cid);
    const computedHash = this._computeHash(`${strategyData.bytecode}${strategyData.timestamp}`);
    return computedHash === expectedHash;
  }

  async getStrategyMetadata(strategyId) {
    if (!this.strategyRegistry[strategyId]) {
      throw new Error('STRATEGY_NOT_FOUND');
    }
    return this.strategyRegistry[strategyId];
  }

  async getProvenanceEntry(index) {
    if (index < 0 || index >= this.provenanceChain.length) {
      throw new Error('INDEX_OUT_OF_BOUNDS');
    }
    return this.provenanceChain[index];
  }

  async getActiveStrategyPerformance() {
    const active = await this.getActiveStrategy();
    const strategyId = active.strategyId;
    const metrics = await this.getPerformanceHistory(strategyId);
    if (metrics.length === 0) {
      return {
        strategyId,
        metrics: [],
        summary: null
      };
    }
    const totalTrades = metrics.reduce((sum, m) => sum + (m.trades || 0), 0);
    const totalPnl = metrics.reduce((sum, m) => sum + (m.pnl || 0), 0);
    const winRate = metrics.reduce((sum, m) => sum + (m.wins || 0), 0) / totalTrades;
    return {
      strategyId,
      metrics,
      summary: {
        totalTrades,
        totalPnl,
        winRate,
        lastUpdated: metrics[metrics.length - 1].timestamp
      }
    };
  }

  async getStrategyComparison(strategyIds) {
    const comparisons = [];
    for (const strategyId of strategyIds) {
      const metrics = await this.getPerformanceHistory(strategyId);
      if (metrics.length > 0) {
        const totalTrades = metrics.reduce((sum, m) => sum + (m.trades || 0), 0);
        const totalPnl = metrics.reduce((sum, m) => sum + (m.pnl || 0), 0);
        comparisons.push({
          strategyId,
          totalTrades,
          totalPnl,
          winRate: metrics.reduce((sum, m) => sum + (m.wins || 0), 0) / totalTrades
        });
      }
    }
    return comparisons.sort((a, b) => b.totalPnl - a.totalPnl);
  }

  async getProvenanceProof(cid) {
    const entry = this.provenanceChain.find(e => e.cid === cid);
    if (!entry) {
      throw new Error('CID_NOT_FOUND_IN_PROVENANCE');
    }
    return {
      entry,
      merkleProof: this._generateMerkleProof(entry.merkleHash),
      root: this.getProvenanceRoot()
    };
  }

  async getStrategyVersionHistory(strategyId) {
    return this.provenanceChain
      .filter(e => e.strategyId === strategyId)
      .map(e => ({
        version: e.metadata.version,
        cid: e.cid,
        timestamp: e.timestamp,
        isActive: this.strategyRegistry[e.strategyId]?.isActive || false
      }))
      .sort((a, b) => b.timestamp - a.timestamp);
  }

  async getSystemHealth() {
    return {
      ipfsConnected: !!this.ipfs,
      registrySize: Object.keys(this.strategyRegistry).length,
      provenanceChainLength: this.provenanceChain.length,
      activeStrategy: Object.values(this.strategyRegistry).find(s => s.isActive)?.strategyId || null,
      lastProvenanceUpdate: this.provenanceChain.length > 0 ? this.provenanceChain[this.provenanceChain.length - 1].timestamp : null,
      dataIntegrity: {
        registryValid: this._validateRegistry(),
        provenanceValid: this._validateProvenanceChain()
      }
    };
  }

  _validateRegistry() {
    for (const [id, data] of Object.entries(this.strategyRegistry)) {
      if (!data.cid || !data.version || !data.timestamp) {
        return false;
      }
    }
    return true;
  }

  _validateProvenanceChain() {
    for (let i = 1; i < this.provenanceChain.length; i++) {
      const current = this.provenanceChain[i];
      const previous = this.provenanceChain[i - 1];
      if (current.previousHash !== previous.merkleHash) {
        return false;
      }
    }
    return true;
  }

  async getStrategyByVersion(version) {
    const candidates = Object.values(this.strategyRegistry).filter(s => s.version === version);
    if (candidates.length === 0) {
      throw new Error('VERSION_NOT_FOUND');
    }
    const active = candidates.find(s => s.isActive);
    if (active) {
      return this.getStrategy(active.cid);
    }
    return this.getStrategy(candidates[0].cid);
  }

  async getLatestStrategy() {
    const sorted = Object.entries(this.strategyRegistry)
      .sort((a, b) => b[1].timestamp - a[1].timestamp);
    if (sorted.length === 0) {
      throw new Error('NO_STRATEGIES');
    }
    return this.getStrategy(sorted[0][1].cid);
  }

  async getStrategyByCid(cid) {
    const registryEntry = Object.values(this.strategyRegistry).find(s => s.cid === cid);
    if (!registryEntry) {
      throw new Error('CID_NOT_IN_REGISTRY');
    }
    return this.getStrategy(cid);
  }

  async getProvenanceChainSnapshot() {
    return {
      chain: this.provenanceChain,
      root: this.getProvenanceRoot(),
      length: this.provenanceChain.length,
      timestamp: Date.now()
    };
  }

  async getStrategyPerformanceSummary(strategyId) {
    const metrics = await this.getPerformanceHistory(strategyId);
    if (metrics.length === 0) {
      return {
        strategyId,
        hasMetrics: false,
        summary: null
      };
    }
    const trades = metrics.map(m => m.trades || 0);
    const pnls = metrics.map(m => m.pnl || 0);
    const wins = metrics.map(m => m.wins || 0);
    const totalTrades = trades.reduce((a, b) => a + b, 0);
    const totalPnl = pnls.reduce((a, b) => a + b, 0);
    const totalWins = wins.reduce((a, b) => a + b, 0);
    const winRate = totalTrades > 0 ? totalWins / totalTrades : 0;
    const avgPnlPerTrade = totalTrades > 0 ? totalPnl / totalTrades : 0;
    const maxPnl = Math.max(...pnls);
    const minPnl = Math.min(...pnls);
    return {
      strategyId,
      hasMetrics: true,
      summary: {
        totalTrades,
        totalPnl,
        winRate,
        avgPnlPerTrade,
        maxPnl,
        minPnl,
        lastUpdated: metrics[metrics.length - 1].timestamp
      }
    };
  }

  async getProvenanceVerification(cid) {
    const entry = this.provenanceChain.find(e => e.cid === cid);
    if (!entry) {
      throw new Error('CID_NOT_FOUND');
    }
    const proof = this._generateMerkleProof(entry.merkleHash);
    const isValid = proof.root === this.getProvenanceRoot();
    return {
      cid,
      entry,
      proof,
      isValid,
      root: this.getProvenanceRoot()
    };
  }

  async getStrategyLifecycle(strategyId) {
    const registryEntry = this.strategyRegistry[strategyId];
    if (!registryEntry) {
      throw new Error('STRATEGY_NOT_FOUND');
    }
    const history = this.provenanceChain.filter(e => e.strategyId === strategyId);
    const performance = await this.getPerformanceHistory(strategyId);
    return {
      strategyId,
      registryEntry,
      versionHistory: history.map(e => ({
        version: e.metadata.version,
        timestamp: e.timestamp,
        isActive: e.strategyId === strategyId && registryEntry.isActive
      })),
      performanceHistory: performance,
      currentStatus: registryEntry.isActive ? 'ACTIVE' : 'INACTIVE',
      totalVersions: history.length,
      totalPerformanceRecords: performance.length
    };
  }

  async getSystemMetrics() {
    return {
      totalStrategies: Object.keys(this.strategyRegistry).length,
      activeStrategies: Object.values(this.strategyRegistry).filter(s => s.isActive).length,
      totalProvenanceEntries: this.provenanceChain.length,
      totalPerformanceRecords: Object.values(this.performanceMetrics).reduce((sum, m) => sum + Object.keys(m).length, 0),
      registrySize: JSON.stringify(this.strategyRegistry).length,
      provenanceChainSize: JSON.stringify(this.provenanceChain).length,
      lastRegistryUpdate: this.strategyRegistry[Object.keys(this.strategyRegistry).pop()]?.timestamp || null,
      lastProvenanceUpdate: this.provenanceChain.length > 0 ? this.provenanceChain[this.provenanceChain.length - 1].timestamp : null
    };
  }

  async getStrategyByMetadata(metadataFilter) {
    const results = [];
    for (const [id, data] of Object.entries(this.strategyRegistry)) {
      let matches = true;
      for (const [key, value] of Object.entries(metadataFilter)) {
        if (data.metadata[key] !== value) {
          matches = false;
          break;
        }
      }
      if (matches) {
        results.push(await this.getStrategy(id));
      }
    }
    return results;
  }

  async getProvenanceChainByVersion(version) {
    return this.provenanceChain.filter(e => e.metadata.version === version);
  }

  async getStrategyComparisonSummary(strategyIds) {
    const comparisons = [];
    for (const strategyId of strategyIds) {
      const summary = await this.getStrategyPerformanceSummary(strategyId);
      if (summary.hasMetrics) {
        comparisons.push({
          strategyId,
          ...summary.summary
        });
      }
    }
    return comparisons.sort((a, b) => b.totalPnl - a.totalPnl);
  }

  async getStrategyVersionInfo(strategyId, version) {
    const history = this.provenanceChain.filter(e => e.strategyId === strategyId);
    const entry = history.find(e => e.metadata.version === version);
    if (!entry) {
      throw new Error('VERSION_NOT_FOUND');
    }
    return {
      strategyId,
      version,
      cid: entry.cid,
      timestamp: entry.timestamp,
      isActive: this.strategyRegistry[strategyId]?.isActive || false,
      merkleProof: this._generateMerkleProof(entry.merkleHash)
    };
  }

  async getProvenanceChainRoot() {
    return this.getProvenanceRoot();
  }

  async getStrategyRegistry() {
    return this.strategyRegistry;
  }

  async getProvenanceChain() {
    return this.provenanceChain;
  }

  async getPerformanceMetrics() {
    return this.performanceMetrics;
  }

  async getStrategyById(strategyId) {
    if (!this.strategyRegistry[strategyId]) {
      throw new Error('STRATEGY_NOT_FOUND');
    }
    return this.getStrategy(this.strategyRegistry[strategyId].cid);
  }

  async getStrategyByCid(cid) {
    const registryEntry = Object.values(this.strategyRegistry).find(s => s.cid === cid);
    if (!registryEntry) {
      throw new Error('CID_NOT_IN_REGISTRY');
    }
    return this.getStrategy(cid);
  }

  async getProvenanceEntryByIndex(index) {
    if (index < 0 || index >= this.provenanceChain.length) {
      throw new Error('INDEX_OUT_OF_BOUNDS');
    }
    return this.provenanceChain[index];
  }

  async getStrategyVersionCount(strategyId) {
    return this.provenanceChain.filter(e => e.strategyId === strategyId).length;
  }

  async getProvenanceChainLength() {
    return this.provenanceChain.length;
  }

  async getActiveStrategyId() {
    const active = Object.entries(this.strategyRegistry).find(([_, s]) => s.isActive);
    return active ? active[0] : null;
  }

  async getStrategyMetadataById(strategyId) {
    if (!this.strategyRegistry[strategyId]) {
      throw new Error('STRATEGY_NOT_FOUND');
    }
    return this.strategyRegistry[strategyId];
  }

  async getProvenanceChainByTimestampRange(start, end) {
    return this.provenanceChain.filter(e => e.timestamp >= start && e.timestamp <= end);
  }

  async getStrategyPerformanceByTimeRange(strategyId, start, end) {
    const metrics = await this.getPerformanceHistory(strategyId);
    return metrics.filter(m => m.timestamp >= start && m.timestamp <= end);
  }

  async getStrategyVersionHistory(strategyId) {
    return this.provenanceChain
      .filter(e => e.strategyId === strategyId)
      .map(e => ({
        version: e.metadata.version,
        cid: e.cid,
        timestamp: e.timestamp,
        isActive: this.strategyRegistry[e.strategyId]?.isActive || false
      }))
      .sort((a, b) => b.timestamp - a.timestamp);
  }

  async getProvenanceChainSnapshot() {
    return {
      chain: this.provenanceChain,
      root: this.getProvenanceRoot(),
      length: this.provenanceChain.length,
      timestamp: Date.now()
    };
  }

  async getStrategyPerformanceSummary(strategyId) {
    const metrics = await this.getPerformanceHistory(strategyId);
    if (metrics.length === 0) {
      return {
        strategyId,
        hasMetrics: false,
        summary: null
      };
    }
    const trades = metrics.map(m => m.trades || 0);
    const pnls = metrics.map(m => m.pnl || 0);
    const wins = metrics.map(m => m.wins || 0);
    const totalTrades = trades.reduce((a, b) => a + b, 0);
    const totalPnl = pnls.reduce((a, b) => a + b, 0);
    const totalWins = wins.reduce((a, b) => a + b, 0);
    const winRate = totalTrades > 0 ? totalWins / totalTrades : 0;
    const avgPnlPerTrade = totalTrades > 0 ? totalPnl / totalTrades : 0;
    const maxPnl = Math.max(...pnls);
    const minPnl = Math.min(...pnls);
    return {
      strategyId,
      hasMetrics: true,
      summary: {
        totalTrades,
        totalPnl,
        winRate,
        avgPnlPerTrade,
        maxPnl,
        minPnl,
        lastUpdated: metrics[metrics.length - 1].timestamp
      }
    };
  }

  async getProvenanceVerification(cid) {
    const entry = this.provenanceChain.find(e => e.cid === cid);
    if (!entry) {
      throw new Error('CID_NOT_FOUND');
    }
    const proof = this._generateMerkleProof(entry.merkleHash);
    const isValid = proof.root === this.getProvenanceRoot();
    return {
      cid,
      entry,
      proof,
      isValid,
      root: this.getProvenanceRoot()
    };
  }

  async getStrategyLifecycle(strategyId) {
    const registryEntry = this.strategyRegistry[strategyId];
    if (!registryEntry) {
      throw new Error('STRATEGY_NOT_FOUND');
    }
    const history = this.provenanceChain.filter(e => e.strategyId === strategyId);
    const performance = await this.getPerformanceHistory(strategyId);
    return {
      strategyId,
      registryEntry,
      versionHistory: history.map(e => ({
        version: e.metadata.version,
        timestamp: e.timestamp,
        isActive: e.strategyId === strategyId && registryEntry.isActive
      })),
      performanceHistory: performance,
      currentStatus: registryEntry.isActive ? 'ACTIVE' : 'INACTIVE',
      totalVersions: history.length,
      totalPerformanceRecords: performance.length
    };
  }

  async getSystemMetrics() {
    return {
      totalStrategies: Object.keys(this.strategyRegistry).length,
      activeStrategies: Object.values(this.strategyRegistry).filter(s => s.isActive).length,
      totalProvenanceEntries: this.provenanceChain.length,
      totalPerformanceRecords: Object.values(this.performanceMetrics).reduce((sum, m) => sum + Object.keys(m).length, 0),
      registrySize: JSON.stringify(this.strategyRegistry).length,
      provenanceChainSize: JSON.stringify(this.provenanceChain).length,
      lastRegistryUpdate: this.strategyRegistry[Object.keys(this.strategyRegistry).pop()]?.timestamp || null,
      lastProvenanceUpdate: this.provenanceChain.length > 0 ? this.provenanceChain[this.provenanceChain.length - 1].timestamp : null
    };
  }

  async getStrategyByMetadata(metadataFilter) {
    const results = [];
    for (const [id, data] of Object.entries(this.strategyRegistry)) {
      let matches = true;
      for (const [key, value] of Object.entries(metadataFilter)) {
        if (data.metadata[key] !== value) {
          matches = false;
          break;
        }
      }
      if (matches) {
        results.push(await this.getStrategy(id));
      }
    }
    return results;
  }

  async getProvenanceChainByVersion(version) {
    return this.provenanceChain.filter(e => e.metadata.version === version);
  }

  async getStrategyComparisonSummary(strategyIds) {
    const comparisons = [];
    for (const strategyId of strategyIds) {
      const summary = await this.getStrategyPerformanceSummary(strategyId);
      if (summary.hasMetrics) {
        comparisons.push({
          strategyId,
          ...summary.summary
        });
      }
    }
    return comparisons.sort((a, b) => b.totalPnl - a.totalPnl);
  }

  async getStrategyVersionInfo(strategyId, version) {
    const history = this.provenanceChain.filter(e => e.strategyId === strategyId);
    const entry = history.find(e => e.metadata.version === version);
    if (!entry) {
      throw new Error('VERSION_NOT_FOUND');
    }
    return {
      strategyId,
      version,
      cid: entry.cid,
      timestamp: entry.timestamp,
      isActive: this.strategyRegistry[strategyId]?.isActive || false,
      merkleProof: this._generateMerkleProof(entry.merkleHash)
    };
  }

  async getProvenanceChainRoot() {
    return this.getProvenanceRoot();
  }

  async getStrategyRegistry() {
    return this.strategyRegistry;
  }

  async getProvenanceChain() {
    return this.provenanceChain;
  }

  async getPerformanceMetrics() {
    return this.performanceMetrics;
  }

  async getStrategyById(strategyId) {
    if (!this.strategyRegistry[strategyId]) {
      throw new Error('STRATEGY_NOT_FOUND');
    }
    return this.getStrategy(this.strategyRegistry[strategyId].cid);
  }

  async getStrategyByCid(cid) {
    const registryEntry = Object.values(this.strategyRegistry).find(s => s.cid === cid);
    if (!registryEntry) {
      throw new Error('CID_NOT_IN_REGISTRY');
    }
    return this.getStrategy(cid);
  }

  async getProvenanceEntryByIndex(index) {
    if (index < 0 || index >= this.provenanceChain.length) {
      throw new Error('INDEX_OUT_OF_BOUNDS');
    }
    return this.provenanceChain[index];
  }

  async getStrategyVersionCount(strategyId) {
    return this.provenanceChain.filter(e => e.strategyId === strategyId).length;
  }

  async getProvenanceChainLength() {
    return this.provenanceChain.length;
  }

  async getActiveStrategyId() {
    const active = Object.entries(this.strategyRegistry).find(([_, s]) => s.isActive);
    return active ? active[0] : null;
  }

  async getStrategyMetadataById(strategyId) {
    if (!this.strategyRegistry[strategyId]) {
      throw new Error('STRATEGY_NOT_FOUND');
    }
    return this.strategyRegistry[strategyId];
  }

  async getProvenanceChainByTimestampRange(start, end) {
    return this.provenanceChain.filter(e => e.timestamp >= start && e.timestamp <= end);
  }

  async getStrategyPerformanceByTimeRange(strategyId, start, end) {
    const metrics = await this.getPerformanceHistory(strategyId);
    return metrics.filter(m => m.timestamp >= start && m.timestamp <= end);
  }

  async getStrategyVersionHistory(strategyId) {
    return this.provenanceChain
      .filter(e => e.strategyId === strategyId)
      .map(e => ({
        version: e.metadata.version,
        cid: e.cid,
        timestamp: e.timestamp,
        isActive: this.strategyRegistry[e.strategyId]?.isActive || false
      }))
      .sort((a, b) => b.timestamp - a.timestamp);
  }

  async getProvenanceChainSnapshot() {
    return {
      chain: this.provenanceChain,
      root: this.getProvenanceRoot(),
      length: this.provenanceChain.length,
      timestamp: Date.now()
    };
  }

  async getStrategyPerformanceSummary(strategyId) {
    const metrics = await this.getPerformanceHistory(strategyId);
    if (metrics.length === 0) {
      return {
        strategyId,
        hasMetrics: false,
        summary: null
      };
    }
    const trades = metrics.map(m => m.trades || 0);
    const pnls = metrics.map(m => m.pnl || 0);
    const wins = metrics.map(m => m.wins || 0);
    const totalTrades = trades.reduce((a, b) => a + b, 0);
    const totalPnl = pnls.reduce((a, b) => a + b, 0);
    const totalWins = wins.reduce((a, b) => a + b, 0);
    const winRate = totalTrades > 0 ? totalWins / totalTrades : 0;
    const avgPnlPerTrade = totalTrades > 0 ? totalPnl / totalTrades : 0;
    const maxPnl = Math.max(...pnls);
    const minPnl = Math.min(...pnls);
    return {
      strategyId,
      hasMetrics: true,
      summary: {
        totalTrades,
        totalPnl,
        winRate,
        avgPnlPerTrade,
        maxPnl,
        minPnl,
        lastUpdated: metrics[metrics.length - 1].timestamp
      }
    };
  }

  async getProvenanceVerification(cid) {
   