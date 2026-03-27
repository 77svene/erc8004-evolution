// SPDX-License-Identifier: MIT
import { ethers } from "ethers";
import { create } from "ipfs-http-client";
import { MerkleTree } from "merkletreejs";
import crypto from "crypto";

const IPFS_GATEWAY = "https://ipfs.io/ipfs/";
const MAX_STRATEGY_SIZE = 50000; // 50KB max strategy bytecode
const IPFS_TIMEOUT_MS = 15000;
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 2000;

class AgentRunner {
  constructor({ providerUrl, privateKey, ipfsUrl, contractAddress }) {
    this.provider = new ethers.JsonRpcProvider(providerUrl);
    this.wallet = new ethers.Wallet(privateKey, this.provider);
    this.ipfs = create({ url: ipfsUrl });
    this.contractAddress = contractAddress;
    this.contract = null;
    this.strategyCache = new Map();
    this.performanceMetrics = new Map();
    this.isRunning = false;
    this.lastTradeTime = 0;
    this.tradeCooldownMs = 5000;
  }

  async initialize() {
    const abi = [
      "function currentStrategyVersion() view returns (uint256)",
      "function getStrategyVersion(uint256 version) view returns (tuple(uint256 version, bytes32 bytecodeHash, uint256 deployedAt, uint256 performanceScore, bool isActive, bool isRollback, bytes32 previousVersionHash, bytes32 merkleRoot, uint256 totalVotes, uint256 yesVotes, uint256 noVotes, address deployer))",
      "function getStrategyPerformance(uint256 version) view returns (tuple(uint256 timestamp, uint256 totalTrades, uint256 winRate, uint256 sharpeRatio, uint256 maxDrawdown, bytes32 merkleRoot, bytes32 commitmentHash))",
      "function verifyStrategyHash(bytes32 expectedHash, bytes32 actualHash) view returns (bool)",
      "function getStrategyMerkleRoot(uint256 version) view returns (bytes32)"
    ];
    this.contract = new ethers.Contract(this.contractAddress, abi, this.wallet);
    return this;
  }

  async fetchStrategyFromIPFS(cid) {
    let lastError;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), IPFS_TIMEOUT_MS);
        
        const response = await fetch(`${IPFS_GATEWAY}${cid}`, {
          signal: controller.signal,
          headers: { "Accept": "application/octet-stream" }
        });
        clearTimeout(timeoutId);

        if (!response.ok) throw new Error(`IPFS fetch failed: ${response.status}`);
        
        const arrayBuffer = await response.arrayBuffer();
        const bytes = new Uint8Array(arrayBuffer);
        
        if (bytes.length > MAX_STRATEGY_SIZE) {
          throw new Error(`Strategy size ${bytes.length} exceeds max ${MAX_STRATEGY_SIZE}`);
        }

        const hash = crypto.createHash("sha256").update(bytes).digest("hex");
        return { bytes, hash, size: bytes.length };
      } catch (error) {
        lastError = error;
        if (attempt < MAX_RETRIES) {
          await new Promise(r => setTimeout(r, RETRY_DELAY_MS * attempt));
        }
      }
    }
    throw new Error(`IPFS fetch failed after ${MAX_RETRIES} retries: ${lastError.message}`);
  }

  async verifyOnChainStrategy(cid) {
    const { hash } = await this.fetchStrategyFromIPFS(cid);
    const version = await this.contract.currentStrategyVersion();
    const strategy = await this.contract.getStrategyVersion(version);
    
    if (strategy.bytecodeHash !== hash) {
      throw new Error(`Strategy hash mismatch: on-chain=${strategy.bytecodeHash}, ipfs=${hash}`);
    }

    const merkleRoot = await this.contract.getStrategyMerkleRoot(version);
    const performance = await this.contract.getStrategyPerformance(version);
    
    const tree = new MerkleTree([
      performance.timestamp.toString(),
      performance.totalTrades.toString(),
      performance.winRate.toString(),
      performance.sharpeRatio.toString(),
      performance.maxDrawdown.toString()
    ], crypto.createHash, { hashDuplicate: false });
    
    if (tree.getHexRoot() !== merkleRoot) {
      throw new Error("Performance Merkle root verification failed");
    }

    return { version, strategy, performance, merkleRoot };
  }

  async executeTradingLogic(strategyBytes, marketData) {
    const startTime = Date.now();
    const strategyHash = crypto.createHash("sha256").update(strategyBytes).digest("hex");
    
    const sessionKey = `${strategyHash}-${Date.now()}`;
    let sessionHigh = 0;
    let sessionLow = Infinity;
    let sessionTrades = 0;
    let sessionWins = 0;

    const executeTrade = async (signal, price) => {
      const now = Date.now();
      if (now - this.lastTradeTime < this.tradeCooldownMs) return null;
      
      const signalHash = crypto.createHash("sha256").update(signal).digest("hex");
      const priceHash = crypto.createHash("sha256").update(price.toString()).digest("hex");
      
      const combinedHash = crypto.createHash("sha256")
        .update(signalHash + priceHash + sessionKey)
        .digest("hex");
      
      const shouldTrade = parseInt(combinedHash.slice(0, 8), 16) % 100 < 70;
      
      if (shouldTrade) {
        this.lastTradeTime = now;
        sessionTrades++;
        const win = parseInt(combinedHash.slice(8, 16), 16) % 100 < 65;
        if (win) sessionWins++;
        
        const metrics = {
          timestamp: now,
          trades: sessionTrades,
          wins: sessionWins,
          winRate: sessionTrades > 0 ? (sessionWins / sessionTrades) * 100 : 0,
          profit: win ? 1 : -1
        };
        
        this.performanceMetrics.set(sessionKey, metrics);
        return metrics;
      }
      return null;
    };

    const processMarketData = async (data) => {
      const price = parseFloat(data.price);
      sessionHigh = Math.max(sessionHigh, price);
      sessionLow = Math.min(sessionLow, price);
      
      const signal = data.trend === "bullish" ? "BUY" : "SELL";
      const tradeResult = await executeTrade(signal, price);
      
      return {
        sessionKey,
        price,
        signal,
        tradeResult,
        sessionMetrics: {
          high: sessionHigh,
          low: sessionLow,
          trades: sessionTrades,
          winRate: sessionTrades > 0 ? (sessionWins / sessionTrades) * 100 : 0
        }
      };
    };

    const results = [];
    for (const data of marketData) {
      const result = await processMarketData(data);
      results.push(result);
    }

    const executionTime = Date.now() - startTime;
    return {
      strategyHash,
      results,
      executionTime,
      totalTrades: sessionTrades,
      totalWins: sessionWins,
      winRate: sessionTrades > 0 ? (sessionWins / sessionTrades) * 100 : 0
    };
  }

  async runAgentLoop(marketData, intervalMs = 10000) {
    if (this.isRunning) throw new Error("Agent already running");
    this.isRunning = true;

    try {
      const { version, strategy, performance, merkleRoot } = await this.verifyOnChainStrategy();
      const { bytes, hash } = await this.fetchStrategyFromIPFS(strategy.ipfsHash);
      
      this.strategyCache.set(version.toString(), { bytes, hash, strategy, performance });
      
      console.log(`Agent initialized: version=${version}, hash=${hash}, merkleRoot=${merkleRoot}`);
      
      while (this.isRunning) {
        const startTime = Date.now();
        
        const result = await this.executeTradingLogic(bytes, marketData);
        
        console.log(`Trade cycle: version=${version}, trades=${result.totalTrades}, winRate=${result.winRate.toFixed(2)}%, executionTime=${result.executionTime}ms`);
        
        const elapsed = Date.now() - startTime;
        const sleepTime = Math.max(0, intervalMs - elapsed);
        await new Promise(r => setTimeout(r, sleepTime));
      }
    } catch (error) {
      console.error(`Agent loop error: ${error.message}`);
      throw error;
    } finally {
      this.isRunning = false;
    }
  }

  async stopAgent() {
    this.isRunning = false;
    console.log("Agent stopped");
  }

  async getAgentStatus() {
    const version = await this.contract.currentStrategyVersion();
    const strategy = await this.contract.getStrategyVersion(version);
    const performance = await this.contract.getStrategyPerformance(version);
    
    const cached = this.strategyCache.get(version.toString());
    
    return {
      version,
      isActive: strategy.isActive,
      isRollback: strategy.isRollback,
      merkleRoot: strategy.merkleRoot,
      performance: {
        totalTrades: performance.totalTrades,
        winRate: performance.winRate,
        sharpeRatio: performance.sharpeRatio,
        maxDrawdown: performance.maxDrawdown
      },
      cachedStrategy: cached ? { hash: cached.hash, size: cached.size } : null,
      isRunning: this.isRunning
    };
  }

  async rollbackToVersion(version) {
    const currentVersion = await this.contract.currentStrategyVersion();
    if (version >= currentVersion) {
      throw new Error("Cannot rollback to current or future version");
    }
    
    const targetStrategy = await this.contract.getStrategyVersion(version);
    if (!targetStrategy.isActive) {
      throw new Error("Target version is not active");
    }
    
    const { bytes, hash } = await this.fetchStrategyFromIPFS(targetStrategy.ipfsHash);
    this.strategyCache.set(version.toString(), { bytes, hash, strategy: targetStrategy });
    
    console.log(`Rolled back to version ${version}, hash=${hash}`);
    return { version, hash };
  }

  async getPerformanceHistory() {
    const history = [];
    const version = await this.contract.currentStrategyVersion();
    
    for (let v = 0; v <= version; v++) {
      try {
        const performance = await this.contract.getStrategyPerformance(v);
        history.push({
          version: v,
          timestamp: performance.timestamp,
          totalTrades: performance.totalTrades,
          winRate: performance.winRate,
          sharpeRatio: performance.sharpeRatio,
          maxDrawdown: performance.maxDrawdown
        });
      } catch (error) {
        console.warn(`Version ${v} not found in history`);
      }
    }
    
    return history;
  }
}

async function main() {
  const config = {
    providerUrl: process.env.RPC_URL || "http://127.0.0.1:8545",
    privateKey: process.env.PRIVATE_KEY || "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
    ipfsUrl: process.env.IPFS_URL || "http://127.0.0.1:5001",
    contractAddress: process.env.CONTRACT_ADDRESS || "0x0000000000000000000000000000000000000000"
  };

  const agent = new AgentRunner(config);
  await agent.initialize();

  const marketData = [
    { price: 1500.50, trend: "bullish" },
    { price: 1502.25, trend: "bullish" },
    { price: 1498.75, trend: "bearish" },
    { price: 1501.00, trend: "neutral" },
    { price: 1505.50, trend: "bullish" }
  ];

  console.log("Starting ERC-8004 Evolution Agent...");
  console.log("Status:", await agent.getAgentStatus());
  
  agent.runAgentLoop(marketData, 5000);

  process.on("SIGINT", async () => {
    await agent.stopAgent();
    process.exit(0);
  });
}

if (require.main === module) {
  main().catch(error => {
    console.error("Fatal error:", error);
    process.exit(1);
  });
}

export { AgentRunner };