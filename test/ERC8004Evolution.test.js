// SPDX-License-Identifier: MIT
import { expect } from "chai";
import { ethers } from "hardhat";

// === CONSTANTS FOR COMPOSABILITY ===
const GOVERNANCE_DURATION = 7200; // 2 hours in blocks
const QUORUM_PERCENTAGE = 40; // 40% quorum required
const VOTE_THRESHOLD = 51; // 51% yes votes required
const MAX_STRATEGY_VERSIONS = 100;
const PERFORMANCE_WEIGHT = 10000;
const WIN_RATE_MAX = 10000; // basis points
const SHARPE_SCALE = 1000;
const MAX_DRAWDOWN = 10000; // basis points

// === TEST CONFIGURATION ===
const INITIAL_BALANCE = ethers.parseEther("100");
const INITIAL_GAS_PRICE = ethers.parseUnits("20", "gwei");
const STRATEGY_VERSION_1 = 1;
const STRATEGY_VERSION_2 = 2;
const STRATEGY_VERSION_3 = 3;

describe("ERC8004Evolution - Integration Tests", function () {
  let owner, admin, proposer, voter1, voter2, voter3, executor, auditor;
  let agent, governance, history;
  let strategyBytecode1, strategyBytecode2, strategyBytecode3;

  // === HELPER FUNCTIONS ===
  function generateRandomBytecode(version) {
    return ethers.hexlify(
      ethers.randomBytes(32 + version * 10)
    );
  }

  function calculateMerkleRoot(leaves) {
    const sorted = [...leaves].sort();
    let current = sorted;
    while (current.length > 1) {
      const next = [];
      for (let i = 0; i < current.length; i += 2) {
        const left = current[i];
        const right = i + 1 < current.length ? current[i + 1] : ethers.ZeroHash;
        next.push(ethers.keccak256(ethers.solidityPacked(["bytes32", "bytes32"], [left, right])));
      }
      current = next;
    }
    return current[0];
  }

  function calculatePerformanceScore(winRate, sharpeRatio, maxDrawdown) {
    const winRateScore = (winRate * PERFORMANCE_WEIGHT) / WIN_RATE_MAX;
    const sharpeScore = (sharpeRatio * SHARPE_SCALE) / 1000;
    const drawdownPenalty = (maxDrawdown * PERFORMANCE_WEIGHT) / MAX_DRAWDOWN;
    return Math.min(10000, Math.max(0, winRateScore + sharpeScore - drawdownPenalty));
  }

  // === DEPLOYMENT ===
  before(async function () {
    [owner, admin, proposer, voter1, voter2, voter3, executor, auditor] = await ethers.getSigners();

    // Deploy contracts
    const ERC8004Agent = await ethers.getContractFactory("ERC8004Agent");
    const StrategyGovernance = await ethers.getContractFactory("StrategyGovernance");
    const StrategyHistory = await ethers.getContractFactory("StrategyHistory");

    agent = await ERC8004Agent.deploy();
    governance = await StrategyGovernance.deploy();
    history = await StrategyHistory.deploy();

    // Initialize governance
    await governance.initialize();
    await governance.grantRole(await governance.PROPOSER_ROLE(), proposer.address);
    await governance.grantRole(await governance.VOTER_ROLE(), voter1.address);
    await governance.grantRole(await governance.VOTER_ROLE(), voter2.address);
    await governance.grantRole(await governance.VOTER_ROLE(), voter3.address);
    await governance.grantRole(await governance.EXECUTOR_ROLE(), executor.address);
    await governance.grantRole(await governance.AUDITOR_ROLE(), auditor.address);

    // Initialize agent
    await agent.initialize(
      governance.address,
      history.address,
      owner.address
    );

    // Grant roles
    await agent.grantRole(await agent.AGENT_ADMIN_ROLE(), admin.address);
    await agent.grantRole(await agent.STRATEGY_UPGRADER_ROLE(), proposer.address);

    // Generate dynamic strategy bytecode
    strategyBytecode1 = generateRandomBytecode(STRATEGY_VERSION_1);
    strategyBytecode2 = generateRandomBytecode(STRATEGY_VERSION_2);
    strategyBytecode3 = generateRandomBytecode(STRATEGY_VERSION_3);
  });

  // === TEST: INITIAL STATE ===
  describe("Initial State", function () {
    it("Should have correct initial state", async function () {
      expect(await agent.getStrategyVersion()).to.equal(0);
      expect(await agent.getStrategyGovernance()).to.equal(governance.address);
      expect(await agent.getStrategyHistory()).to.equal(history.address);
      expect(await agent.owner()).to.equal(owner.address);
    });

    it("Should have correct governance state", async function () {
      expect(await governance.getAgent()).to.equal(agent.address);
      expect(await governance.getQuorumPercentage()).to.equal(QUORUM_PERCENTAGE);
      expect(await governance.getVoteThreshold()).to.equal(VOTE_THRESHOLD);
    });
  });

  // === TEST: STRATEGY PROPOSAL ===
  describe("Strategy Proposal", function () {
    it("Should allow proposer to create strategy proposal", async function () {
      const tx = await governance.proposeStrategy(
        agent.address,
        strategyBytecode2,
        "Test Strategy v2",
        GOVERNANCE_DURATION
      );

      const receipt = await tx.wait();
      const event = receipt.logs.find(
        (log) => log.fragment?.name === "StrategyProposed"
      );

      expect(event).to.not.be.undefined;
      const proposal = await governance.getProposals(agent.address);
      expect(proposal.length).to.equal(1);
      expect(proposal[0].strategyHash).to.equal(ethers.keccak256(strategyBytecode2));
      expect(proposal[0].status).to.equal("ACTIVE");
    });

    it("Should reject proposal from non-proposer", async function () {
      await expect(
        governance.connect(voter1).proposeStrategy(
          agent.address,
          strategyBytecode2,
          "Test Strategy v2",
          GOVERNANCE_DURATION
        )
      ).to.be.revertedWithCustomError(governance, "AccessControlUnauthorizedAccount");
    });
  });

  // === TEST: VOTING MECHANISM ===
  describe("Voting Mechanism", function () {
    let proposalId;

    beforeEach(async function () {
      const tx = await governance.proposeStrategy(
        agent.address,
        strategyBytecode2,
        "Test Strategy v2",
        GOVERNANCE_DURATION
      );
      const receipt = await tx.wait();
      const event = receipt.logs.find(
        (log) => log.fragment?.name === "StrategyProposed"
      );
      const proposalData = event.args;
      proposalId = proposalData.proposalId;
    });

    it("Should allow voters to cast votes", async function () {
      await governance.connect(voter1).vote(agent.address, proposalId, true);
      await governance.connect(voter2).vote(agent.address, proposalId, true);
      await governance.connect(voter3).vote(agent.address, proposalId, false);

      const proposal = await governance.getProposals(agent.address);
      expect(proposal[0].yesVotes).to.equal(2);
      expect(proposal[0].noVotes).to.equal(1);
      expect(proposal[0].totalVotes).to.equal(3);
    });

    it("Should reject vote from non-voter", async function () {
      await expect(
        governance.connect(admin).vote(agent.address, proposalId, true)
      ).to.be.revertedWithCustomError(governance, "AccessControlUnauthorizedAccount");
    });

    it("Should reject duplicate vote", async function () {
      await governance.connect(voter1).vote(agent.address, proposalId, true);
      await expect(
        governance.connect(voter1).vote(agent.address, proposalId, true)
      ).to.be.revertedWithCustomError(governance, "VoteAlreadyCast");
    });
  });

  // === TEST: STRATEGY UPGRADE EXECUTION ===
  describe("Strategy Upgrade Execution", function () {
    let proposalId;

    beforeEach(async function () {
      const tx = await governance.proposeStrategy(
        agent.address,
        strategyBytecode2,
        "Test Strategy v2",
        GOVERNANCE_DURATION
      );
      const receipt = await tx.wait();
      const event = receipt.logs.find(
        (log) => log.fragment?.name === "StrategyProposed"
      );
      const proposalData = event.args;
      proposalId = proposalData.proposalId;

      // Cast votes to pass proposal
      await governance.connect(voter1).vote(agent.address, proposalId, true);
      await governance.connect(voter2).vote(agent.address, proposalId, true);
      await governance.connect(voter3).vote(agent.address, proposalId, true);
    });

    it("Should allow executor to execute upgrade after voting period", async function () {
      // Fast forward time
      await ethers.provider.send("evm_increaseTime", [GOVERNANCE_DURATION + 1]);
      await ethers.provider.send("evm_mine");

      const tx = await governance.connect(executor).executeUpgrade(
        agent.address,
        proposalId
      );

      const receipt = await tx.wait();
      const event = receipt.logs.find(
        (log) => log.fragment?.name === "StrategyUpgraded"
      );

      expect(event).to.not.be.undefined;
      expect(await agent.getStrategyVersion()).to.equal(STRATEGY_VERSION_2);
    });

    it("Should reject upgrade from non-executor", async function () {
      await expect(
        governance.connect(voter1).executeUpgrade(agent.address, proposalId)
      ).to.be.revertedWithCustomError(governance, "AccessControlUnauthorizedAccount");
    });

    it("Should reject upgrade before voting period ends", async function () {
      await expect(
        governance.connect(executor).executeUpgrade(agent.address, proposalId)
      ).to.be.revertedWithCustomError(governance, "VotingPeriodNotEnded");
    });
  });

  // === TEST: PERFORMANCE TRACKING ===
  describe("Performance Tracking", function () {
    beforeEach(async function () {
      // Create and execute a strategy upgrade
      const tx = await governance.proposeStrategy(
        agent.address,
        strategyBytecode2,
        "Test Strategy v2",
        GOVERNANCE_DURATION
      );
      const receipt = await tx.wait();
      const event = receipt.logs.find(
        (log) => log.fragment?.name === "StrategyProposed"
      );
      const proposalData = event.args;
      const proposalId = proposalData.proposalId;

      await governance.connect(voter1).vote(agent.address, proposalId, true);
      await governance.connect(voter2).vote(agent.address, proposalId, true);
      await governance.connect(voter3).vote(agent.address, proposalId, true);

      await ethers.provider.send("evm_increaseTime", [GOVERNANCE_DURATION + 1]);
      await ethers.provider.send("evm_mine");

      await governance.connect(executor).executeUpgrade(agent.address, proposalId);
    });

    it("Should record performance metrics for strategy version", async function () {
      const winRate = 7500; // 75%
      const sharpeRatio = 2500; // 2.5
      const maxDrawdown = 2000; // 20%

      const performanceScore = calculatePerformanceScore(
        winRate,
        sharpeRatio,
        maxDrawdown
      );

      await history.recordPerformance(
        agent.address,
        STRATEGY_VERSION_2,
        winRate,
        sharpeRatio,
        maxDrawdown
      );

      const record = await history.getVersionRecord(agent.address, STRATEGY_VERSION_2);
      expect(record.version).to.equal(STRATEGY_VERSION_2);
      expect(record.performanceScore).to.equal(performanceScore);
      expect(record.isActive).to.be.true;
    });

    it("Should maintain version history chain", async function () {
      const record = await history.getVersionRecord(agent.address, STRATEGY_VERSION_2);
      expect(record.previousVersionHash).to.equal(ethers.ZeroHash);
      expect(record.merkleRoot).to.not.equal(ethers.ZeroHash);
    });
  });

  // === TEST: ROLLBACK MECHANISM ===
  describe("Rollback Mechanism", function () {
    beforeEach(async function () {
      // Create and execute first upgrade
      const tx1 = await governance.proposeStrategy(
        agent.address,
        strategyBytecode2,
        "Test Strategy v2",
        GOVERNANCE_DURATION
      );
      const receipt1 = await tx1.wait();
      const event1 = receipt1.logs.find(
        (log) => log.fragment?.name === "StrategyProposed"
      );
      const proposalId1 = event1.args.proposalId;

      await governance.connect(voter1).vote(agent.address, proposalId1, true);
      await governance.connect(voter2).vote(agent.address, proposalId1, true);
      await governance.connect(voter3).vote(agent.address, proposalId1, true);

      await ethers.provider.send("evm_increaseTime", [GOVERNANCE_DURATION + 1]);
      await ethers.provider.send("evm_mine");

      await governance.connect(executor).executeUpgrade(agent.address, proposalId1);

      // Create and execute second upgrade
      const tx2 = await governance.proposeStrategy(
        agent.address,
        strategyBytecode3,
        "Test Strategy v3",
        GOVERNANCE_DURATION
      );
      const receipt2 = await tx2.wait();
      const event2 = receipt2.logs.find(
        (log) => log.fragment?.name === "StrategyProposed"
      );
      const proposalId2 = event2.args.proposalId;

      await governance.connect(voter1).vote(agent.address, proposalId2, true);
      await governance.connect(voter2).vote(agent.address, proposalId2, true);
      await governance.connect(voter3).vote(agent.address, proposalId2, true);

      await ethers.provider.send("evm_increaseTime", [GOVERNANCE_DURATION + 1]);
      await ethers.provider.send("evm_mine");

      await governance.connect(executor).executeUpgrade(agent.address, proposalId2);
    });

    it("Should allow rollback to previous version", async function () {
      const tx = await governance.proposeRollback(
        agent.address,
        STRATEGY_VERSION_2,
        "Rollback to v2"
      );

      const receipt = await tx.wait();
      const event = receipt.logs.find(
        (log) => log.fragment?.name === "RollbackProposed"
      );

      expect(event).to.not.be.undefined;
      const rollbackProposal = await governance.getRollbackProposals(agent.address);
      expect(rollbackProposal.length).to.equal(1);
    });

    it("Should verify rollback preserves version chain integrity", async function () {
      const record = await history.getVersionRecord(agent.address, STRATEGY_VERSION_3);
      expect(record.previousVersionHash).to.not.equal(ethers.ZeroHash);
    });
  });

  // === TEST: SECURITY & ACCESS CONTROL ===
  describe("Security & Access Control", function () {
    it("Should prevent unauthorized strategy changes", async function () {
      await expect(
        agent.connect(voter1).upgradeStrategy(strategyBytecode2)
      ).to.be.revertedWithCustomError(agent, "AccessControlUnauthorizedAccount");
    });

    it("Should prevent unauthorized governance actions", async function () {
      await expect(
        governance.connect(admin).proposeStrategy(
          agent.address,
          strategyBytecode2,
          "Test",
          GOVERNANCE_DURATION
        )
      ).to.be.revertedWithCustomError(governance, "AccessControlUnauthorizedAccount");
    });

    it("Should validate zero address checks", async function () {
      await expect(
        agent.initialize(
          ethers.ZeroAddress,
          history.address,
          owner.address
        )
      ).to.be.revertedWith("ERC20: zero address");
    });
  });

  // === TEST: COMPOSABILITY & EXTENSIBILITY ===
  describe("Composability & Extensibility", function () {
    it("Should allow multiple concurrent proposals", async function () {
      const tx1 = await governance.proposeStrategy(
        agent.address,
        strategyBytecode2,
        "Test Strategy v2",
        GOVERNANCE_DURATION
      );
      const tx2 = await governance.proposeStrategy(
        agent.address,
        strategyBytecode3,
        "Test Strategy v3",
        GOVERNANCE_DURATION
      );

      await tx1.wait();
      await tx2.wait();

      const proposals = await governance.getProposals(agent.address);
      expect(proposals.length).to.be.greaterThan(1);
    });

    it("Should support version history beyond MAX_STRATEGY_VERSIONS", async function () {
      for (let i = 0; i < MAX_STRATEGY_VERSIONS + 10; i++) {
        const bytecode = generateRandomBytecode(i + 1);
        const tx = await governance.proposeStrategy(
          agent.address,
          bytecode,
          `Test Strategy v${i + 1}`,
          GOVERNANCE_DURATION
        );
        await tx.wait();
      }

      const proposals = await governance.getProposals(agent.address);
      expect(proposals.length).to.be.greaterThan(MAX_STRATEGY_VERSIONS);
    });

    it("Should maintain Merkle root integrity across versions", async function () {
      const record = await history.getVersionRecord(agent.address, STRATEGY_VERSION_2);
      const merkleRoot = record.merkleRoot;
      expect(merkleRoot).to.not.equal(ethers.ZeroHash);
      expect(merkleRoot).to.have.lengthOf(66); // 0x + 64 hex chars
    });
  });

  // === TEST: EDGE CASES ===
  describe("Edge Cases", function () {
    it("Should handle empty vote scenario", async function () {
      const tx = await governance.proposeStrategy(
        agent.address,
        strategyBytecode2,
        "Test Strategy v2",
        GOVERNANCE_DURATION
      );
      await tx.wait();

      const proposals = await governance.getProposals(agent.address);
      expect(proposals[0].yesVotes).to.equal(0);
      expect(proposals[0].noVotes).to.equal(0);
    });

    it("Should handle vote threshold edge case", async function () {
      const tx = await governance.proposeStrategy(
        agent.address,
        strategyBytecode2,
        "Test Strategy v2",
        GOVERNANCE_DURATION
      );
      await tx.wait();

      // Only 1 yes vote out of 3 voters (33.3% < 51% threshold)
      await governance.connect(voter1).vote(agent.address, 1, true);
      await governance.connect(voter2).vote(agent.address, 1, false);
      await governance.connect(voter3).vote(agent.address, 1, false);

      const proposals = await governance.getProposals(agent.address);
      expect(proposals[0].yesVotes).to.equal(1);
      expect(proposals[0].noVotes).to.equal(2);
      expect(proposals[0].status).to.equal("FAILED");
    });

    it("Should handle performance score boundaries", async function () {
      const lowScore = calculatePerformanceScore(0, 0, MAX_DRAWDOWN);
      const highScore = calculatePerformanceScore(WIN_RATE_MAX, 10000, 0);

      expect(lowScore).to.equal(0);
      expect(highScore).to.equal(10000);
    });
  });

  // === TEST: INTEGRATION FLOW ===
  describe("Full Integration Flow", function () {
    it("Should complete full upgrade lifecycle", async function () {
      // Step 1: Propose strategy
      const tx1 = await governance.proposeStrategy(
        agent.address,
        strategyBytecode2,
        "Test Strategy v2",
        GOVERNANCE_DURATION
      );
      const receipt1 = await tx1.wait();
      const event1 = receipt1.logs.find(
        (log) => log.fragment?.name === "StrategyProposed"
      );
      const proposalId1 = event1.args.proposalId;

      // Step 2: Vote
      await governance.connect(voter1).vote(agent.address, proposalId1, true);
      await governance.connect(voter2).vote(agent.address, proposalId1, true);
      await governance.connect(voter3).vote(agent.address, proposalId1, true);

      // Step 3: Execute upgrade
      await ethers.provider.send("evm_increaseTime", [GOVERNANCE_DURATION + 1]);
      await ethers.provider.send("evm_mine");

      const tx2 = await governance.connect(executor).executeUpgrade(
        agent.address,
        proposalId1
      );
      const receipt2 = await tx2.wait();
      const event2 = receipt2.logs.find(
        (log) => log.fragment?.name === "StrategyUpgraded"
      );

      expect(event2).to.not.be.undefined;
      expect(await agent.getStrategyVersion()).to.equal(STRATEGY_VERSION_2);

      // Step 4: Record performance
      await history.recordPerformance(
        agent.address,
        STRATEGY_VERSION_2,
        7500,
        2500,
        2000
      );

      // Step 5: Verify version record
      const record = await history.getVersionRecord(agent.address, STRATEGY_VERSION_2);
      expect(record.version).to.equal(STRATEGY_VERSION_2);
      expect(record.isActive).to.be.true;
    });

    it("Should support multiple upgrade cycles", async function () {
      const versions = [STRATEGY_VERSION_2, STRATEGY_VERSION_3, STRATEGY_VERSION_1];

      for (const version of versions) {
        const bytecode = generateRandomBytecode(version);
        const tx = await governance.proposeStrategy(
          agent.address,
          bytecode,
          `Test Strategy v${version}`,
          GOVERNANCE_DURATION
        );
        const receipt = await tx.wait();
        const event = receipt.logs.find(
          (log) => log.fragment?.name === "StrategyProposed"
        );
        const proposalId = event.args.proposalId;

        await governance.connect(voter1).vote(agent.address, proposalId, true);
        await governance.connect(voter2).vote(agent.address, proposalId, true);
        await governance.connect(voter3).vote(agent.address, proposalId, true);

        await ethers.provider.send("evm_increaseTime", [GOVERNANCE_DURATION + 1]);
        await ethers.provider.send("evm_mine");

        await governance.connect(executor).executeUpgrade(agent.address, proposalId);

        expect(await agent.getStrategyVersion()).to.equal(version);
      }
    });
  });
});