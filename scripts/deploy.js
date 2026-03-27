// scripts/deploy.js
// SPDX-License-Identifier: MIT
// @dev ERC-8004 Evolution Deployment Script
// @notice Deploys StrategyGovernance, StrategyHistory, and ERC8004Agent contracts
// @dev Implements Strategy Provenance Chain (SPC) deployment with verification

const { ethers } = require("ethers");
const fs = require("fs");
const path = require("path");

// === CONFIGURATION ===
const DEPLOYMENT_TIMEOUT = 120000; // 2 minutes per deployment
const MAX_GAS_LIMIT = 10000000;
const VERIFICATION_DELAY = 30000; // 30 seconds between deployments

// === CONTRACT ARTIFACTS ===
const CONTRACTS = {
  StrategyGovernance: "StrategyGovernance",
  StrategyHistory: "StrategyHistory",
  ERC8004Agent: "ERC8004Agent"
};

// === DEPLOYMENT ORDER ===
const DEPLOYMENT_SEQUENCE = [
  "StrategyGovernance",
  "StrategyHistory",
  "ERC8004Agent"
];

/**
 * @dev Load contract artifacts from Hardhat build output
 * @param {string} contractName - Name of the contract to load
 * @returns {object} Contract artifact with abi and bytecode
 */
async function loadArtifact(contractName) {
  const artifactPath = path.join(__dirname, "..", "artifacts", "contracts", `${contractName}.sol`, `${contractName}.json`);
  
  if (!fs.existsSync(artifactPath)) {
    throw new Error(`Artifact not found: ${artifactPath}. Run 'hardhat compile' first.`);
  }
  
  return JSON.parse(fs.readFileSync(artifactPath, "utf8"));
}

/**
 * @dev Get provider and signer from environment
 * @returns {Promise<{provider: ethers.Provider, signer: ethers.Signer}>}
 */
async function getProviderAndSigner() {
  const providerUrl = process.env.RPC_URL || "http://127.0.0.1:8545";
  const privateKey = process.env.PRIVATE_KEY;
  
  if (!privateKey) {
    throw new Error("PRIVATE_KEY environment variable not set");
  }
  
  const provider = new ethers.JsonRpcProvider(providerUrl);
  const signer = new ethers.Wallet(privateKey, provider);
  
  const balance = await provider.getBalance(signer.address);
  console.log(`Deployer: ${signer.address}`);
  console.log(`Balance: ${ethers.formatEther(balance)} ETH`);
  
  if (balance === 0n) {
    throw new Error("Deployer account has zero balance");
  }
  
  return { provider, signer };
}

/**
 * @dev Deploy a single contract with initialization
 * @param {string} contractName - Name of contract to deploy
 * @param {ethers.Signer} signer - Signer to deploy with
 * @param {object} constructorArgs - Arguments for contract constructor
 * @returns {Promise<{contract: ethers.Contract, address: string}>}
 */
async function deployContract(contractName, signer, constructorArgs = []) {
  console.log(`\n🚀 Deploying ${contractName}...`);
  
  const artifact = await loadArtifact(contractName);
  const factory = new ethers.ContractFactory(artifact.abi, artifact.bytecode, signer);
  
  const startTime = Date.now();
  const deploymentTx = await factory.deploy(...constructorArgs, {
    gasLimit: MAX_GAS_LIMIT
  });
  
  await deploymentTx.waitFor(1, { timeout: DEPLOYMENT_TIMEOUT });
  const contract = await deploymentTx;
  const address = contract.target;
  
  const gasUsed = await deploymentTx.wait();
  const gasCost = ethers.formatEther(gasUsed.gasUsed * gasUsed.gasPrice);
  const deployTime = (Date.now() - startTime) / 1000;
  
  console.log(`✅ ${contractName} deployed to: ${address}`);
  console.log(`   Gas Used: ${gasUsed.gasUsed.toString()}`);
  console.log(`   Gas Cost: ${gasCost} ETH`);
  console.log(`   Deploy Time: ${deployTime.toFixed(2)}s`);
  
  return { contract, address };
}

/**
 * @dev Initialize StrategyGovernance contract
 * @param {ethers.Contract} governance - Governance contract instance
 * @param {ethers.Signer} signer - Signer to initialize with
 * @returns {Promise<void>}
 */
async function initializeGovernance(governance, signer) {
  console.log("\n⚙️  Initializing StrategyGovernance...");
  
  const adminRole = await governance.PROPOSER_ROLE();
  const voterRole = await governance.VOTER_ROLE();
  const executorRole = await governance.EXECUTOR_ROLE();
  
  // Set up initial roles
  await governance.grantRole(adminRole, signer.address);
  await governance.grantRole(voterRole, signer.address);
  await governance.grantRole(executorRole, signer.address);
  
  // Set initial configuration
  const VOTING_PERIOD = 86400; // 1 day
  const QUORUM_PERCENTAGE = 2000; // 20% in basis points
  const MIN_PROPOSAL_VALUE = ethers.parseEther("0.1");
  
  await governance.initialize(
    signer.address,
    VOTING_PERIOD,
    QUORUM_PERCENTAGE,
    MIN_PROPOSAL_VALUE
  );
  
  console.log("✅ StrategyGovernance initialized");
}

/**
 * @dev Initialize StrategyHistory contract
 * @param {ethers.Contract} history - History contract instance
 * @returns {Promise<void>}
 */
async function initializeHistory(history) {
  console.log("\n⚙️  Initializing StrategyHistory...");
  
  // Set initial configuration
  const MAX_HISTORY = 100;
  const MAX_METRICS_PER_VERSION = 10;
  
  await history.initialize(MAX_HISTORY, MAX_METRICS_PER_VERSION);
  
  console.log("✅ StrategyHistory initialized");
}

/**
 * @dev Initialize ERC8004Agent contract
 * @param {ethers.Contract} agent - Agent contract instance
 * @param {ethers.Contract} governance - Governance contract instance
 * @param {ethers.Contract} history - History contract instance
 * @param {ethers.Signer} signer - Signer to initialize with
 * @returns {Promise<void>}
 */
async function initializeAgent(agent, governance, history, signer) {
  console.log("\n⚙️  Initializing ERC8004Agent...");
  
  const adminRole = await agent.AGENT_ADMIN_ROLE();
  const upgraderRole = await agent.STRATEGY_UPGRADER_ROLE();
  
  // Set up initial roles
  await agent.grantRole(adminRole, signer.address);
  await agent.grantRole(upgraderRole, signer.address);
  
  // Initialize agent with governance and history contracts
  await agent.initialize(
    signer.address,
    governance.target,
    history.target
  );
  
  console.log("✅ ERC8004Agent initialized");
}

/**
 * @dev Verify contract deployment on Etherscan
 * @param {string} address - Contract address
 * @param {string} network - Network name
 * @returns {Promise<boolean>}
 */
async function verifyContract(address, network) {
  console.log(`\n🔍 Verifying ${address} on ${network}...`);
  
  const apiKey = process.env.ETHERSCAN_API_KEY;
  if (!apiKey) {
    console.log("⚠️  No Etherscan API key, skipping verification");
    return false;
  }
  
  const verificationUrl = `https://api.etherscan.io/api?module=contract&action=verifysourcecode&address=${address}&contractname=ERC8004Agent&sourceCode=${fs.readFileSync(path.join(__dirname, "..", "artifacts", "contracts", "ERC8004Agent.sol", "ERC8004Agent.json"), "utf8")}&codeformat=solidity&apikey=${apiKey}`;
  
  try {
    const response = await fetch(verificationUrl, {
      method: "GET",
      headers: {
        "Content-Type": "application/json"
      }
    });
    
    const data = await response.json();
    
    if (data.status === "1") {
      console.log(`✅ Verification submitted: ${data.result}`);
      return true;
    } else {
      console.log(`⚠️  Verification failed: ${data.message}`);
      return false;
    }
  } catch (error) {
    console.log(`⚠️  Verification error: ${error.message}`);
    return false;
  }
}

/**
 * @dev Save deployment results to file
 * @param {object} deployment - Deployment results
 * @returns {Promise<void>}
 */
async function saveDeploymentResults(deployment) {
  const deploymentPath = path.join(__dirname, "..", "deployment.json");
  const deploymentData = {
    network: process.env.NETWORK || "hardhat",
    timestamp: new Date().toISOString(),
    deployer: deployment.deployer,
    contracts: deployment.contracts,
    verification: deployment.verification
  };
  
  fs.writeFileSync(deploymentPath, JSON.stringify(deploymentData, null, 2));
  console.log(`\n💾 Deployment results saved to: ${deploymentPath}`);
}

/**
 * @dev Main deployment function
 * @returns {Promise<void>}
 */
async function main() {
  console.log("=".repeat(60));
  console.log("🔷 ERC-8004 Evolution Deployment");
  console.log("🔷 Strategy Provenance Chain (SPC)");
  console.log("=".repeat(60));
  
  try {
    // Get provider and signer
    const { provider, signer } = await getProviderAndSigner();
    
    // Check network
    const network = await provider.getNetwork();
    console.log(`\n📡 Network: ${network.name} (${network.chainId})`);
    
    // Deploy contracts in order
    const deployment = {
      deployer: signer.address,
      contracts: {},
      verification: {}
    };
    
    for (const contractName of DEPLOYMENT_SEQUENCE) {
      const { contract, address } = await deployContract(contractName, signer);
      deployment.contracts[contractName] = address;
      
      // Wait between deployments
      if (contractName !== DEPLOYMENT_SEQUENCE[DEPLOYMENT_SEQUENCE.length - 1]) {
        console.log(`⏳ Waiting ${VERIFICATION_DELAY / 1000}s before next deployment...`);
        await new Promise(resolve => setTimeout(resolve, VERIFICATION_DELAY));
      }
    }
    
    // Initialize contracts
    const governance = new ethers.Contract(
      deployment.contracts.StrategyGovernance,
      (await loadArtifact("StrategyGovernance")).abi,
      signer
    );
    
    const history = new ethers.Contract(
      deployment.contracts.StrategyHistory,
      (await loadArtifact("StrategyHistory")).abi,
      signer
    );
    
    const agent = new ethers.Contract(
      deployment.contracts.ERC8004Agent,
      (await loadArtifact("ERC8004Agent")).abi,
      signer
    );
    
    await initializeGovernance(governance, signer);
    await initializeHistory(history);
    await initializeAgent(agent, governance, history, signer);
    
    // Save deployment results
    await saveDeploymentResults(deployment);
    
    // Print summary
    console.log("\n" + "=".repeat(60));
    console.log("🎉 DEPLOYMENT COMPLETE");
    console.log("=".repeat(60));
    console.log(`Deployer: ${deployment.deployer}`);
    console.log(`\n📋 Contract Addresses:`);
    console.log(`   StrategyGovernance: ${deployment.contracts.StrategyGovernance}`);
    console.log(`   StrategyHistory: ${deployment.contracts.StrategyHistory}`);
    console.log(`   ERC8004Agent: ${deployment.contracts.ERC8004Agent}`);
    console.log("=".repeat(60));
    
    // Verify contracts
    for (const [name, address] of Object.entries(deployment.contracts)) {
      deployment.verification[name] = await verifyContract(address, network.name);
    }
    
    console.log("\n✅ All contracts deployed successfully!");
    
  } catch (error) {
    console.error("\n❌ Deployment failed:");
    console.error(error.message);
    process.exit(1);
  }
}

// Run deployment
main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });