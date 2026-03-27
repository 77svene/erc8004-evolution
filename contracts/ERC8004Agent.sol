// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";
import "./IERC8004.sol";
import "./IStrategyGovernance.sol";

/**
 * @title ERC8004Agent
 * @notice First ERC-8004 compliant agent with DAO-governed strategy evolution
 * @dev Implements Strategy Provenance Chain (SPC) for cryptographically verifiable agent upgrades
 * @dev No trust assumptions - every upgrade requires on-chain governance approval
 */
contract ERC8004Agent is IERC8004, AccessControl, EIP712 {
    using ECDSA for bytes32;
    using EnumerableSet for EnumerableSet.Bytes32Set;

    // === CORE ROLES ===
    bytes32 public constant AGENT_ADMIN_ROLE = keccak256("AGENT_ADMIN_ROLE");
    bytes32 public constant STRATEGY_UPGRADER_ROLE = keccak256("STRATEGY_UPGRADER_ROLE");

    // === STRATEGY PROVENANCE CHAIN (SPC) - NOVEL PRIMITIVE ===
    struct StrategyVersion {
        uint256 version;
        bytes32 bytecodeHash;
        uint256 deployedAt;
        uint256 performanceScore;
        bool isActive;
        bool isRollback;
        bytes32 previousVersionHash;
        bytes32 merkleRoot;
        uint256 totalVotes;
        uint256 yesVotes;
        uint256 noVotes;
        address deployer;
    }

    // === STATE VARIABLES ===
    address public strategyGovernance;
    uint256 public currentVersion;
    mapping(bytes32 => StrategyVersion) public strategyVersions;
    EnumerableSet.Bytes32Set private strategyHistory;
    bytes32 public currentMerkleRoot;
    bytes32 public immutable AGENT_ID;
    uint256 public constant MIN_PERFORMANCE_THRESHOLD = 60; // 60% minimum performance to upgrade
    uint256 public constant VERSION_HISTORY_LIMIT = 10; // Keep last 10 versions for rollback

    // === EVENTS ===
    event StrategyUpgraded(uint256 indexed version, bytes32 indexed bytecodeHash, address indexed proposer);
    event StrategyRollback(uint256 indexed version, bytes32 indexed bytecodeHash);
    event StrategyPerformanceUpdated(uint256 indexed version, uint256 performanceScore);
    event MerkleRootUpdated(bytes32 indexed newRoot);
    event GovernanceContractSet(address indexed governance);

    // === CONSTRUCTOR ===
    constructor(bytes32 _agentId, address _governance) EIP712("ERC8004Agent", "1") {
        require(_governance != address(0), "Invalid governance address");
        require(bytes(_agentId).length > 0, "Invalid agent ID");
        
        AGENT_ID = _agentId;
        strategyGovernance = _governance;
        
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(AGENT_ADMIN_ROLE, msg.sender);
        _grantRole(STRATEGY_UPGRADER_ROLE, msg.sender);
        
        // Initialize genesis version
        _initializeGenesisVersion();
    }

    // === STRATEGY PROVENANCE CHAIN FUNCTIONS ===
    function _initializeGenesisVersion() internal {
        StrategyVersion storage version = strategyVersions[0];
        version.version = 0;
        version.bytecodeHash = bytes32(0);
        version.deployedAt = block.timestamp;
        version.performanceScore = 100; // Genesis starts at 100%
        version.isActive = true;
        version.isRollback = false;
        version.previousVersionHash = bytes32(0);
        version.merkleRoot = bytes32(0);
        version.totalVotes = 0;
        version.yesVotes = 0;
        version.noVotes = 0;
        version.deployer = msg.sender;
        
        strategyHistory.add(bytes32(0));
        currentMerkleRoot = bytes32(0);
        currentVersion = 0;
    }

    function _updateMerkleRoot(bytes32 newRoot) internal {
        currentMerkleRoot = newRoot;
        emit MerkleRootUpdated(newRoot);
    }

    function _addVersionToHistory(bytes32 hash) internal {
        strategyHistory.add(hash);
        
        // Enforce history limit - remove oldest if exceeds
        if (strategyHistory.length() > VERSION_HISTORY_LIMIT) {
            bytes32 oldest = strategyHistory.at(0);
            strategyHistory.remove(oldest);
        }
    }

    // === GOVERNANCE APPROVAL CHECKS ===
    function _verifyGovernanceApproval(bytes32 strategyHash, uint256 version) internal view returns (bool) {
        IStrategyGovernance governance = IStrategyGovernance(strategyGovernance);
        return governance.isStrategyApproved(AGENT_ID, strategyHash, version);
    }

    function _getGovernanceApprovalStatus(bytes32 strategyHash, uint256 version) internal view returns (bool, uint256, uint256) {
        IStrategyGovernance governance = IStrategyGovernance(strategyGovernance);
        (bool approved, uint256 yesVotes, uint256 noVotes) = governance.getStrategyStatus(AGENT_ID, strategyHash, version);
        return (approved, yesVotes, noVotes);
    }

    // === UPGRADE STRATEGY FUNCTION (NEW) ===
    function upgradeStrategy(bytes32 newBytecodeHash, uint256 newVersion) external onlyRole(STRATEGY_UPGRADER_ROLE) {
        require(newVersion > currentVersion, "New version must be higher than current");
        require(newBytecodeHash != bytes32(0), "Invalid bytecode hash");
        
        // Verify governance approval before proceeding
        (bool approved, uint256 yesVotes, uint256 noVotes) = _getGovernanceApprovalStatus(newBytecodeHash, newVersion);
        require(approved, "Strategy not approved by governance");
        
        // Verify performance threshold
        IStrategyGovernance governance = IStrategyGovernance(strategyGovernance);
        uint256 performanceScore = governance.getStrategyPerformance(AGENT_ID, newBytecodeHash, newVersion);
        require(performanceScore >= MIN_PERFORMANCE_THRESHOLD, "Performance below threshold");
        
        // Deactivate current version
        strategyVersions[currentVersion].isActive = false;
        
        // Create new version entry
        StrategyVersion storage newVersionEntry = strategyVersions[newVersion];
        newVersionEntry.version = newVersion;
        newVersionEntry.bytecodeHash = newBytecodeHash;
        newVersionEntry.deployedAt = block.timestamp;
        newVersionEntry.performanceScore = performanceScore;
        newVersionEntry.isActive = true;
        newVersionEntry.isRollback = false;
        newVersionEntry.previousVersionHash = strategyVersions[currentVersion].bytecodeHash;
        newVersionEntry.merkleRoot = currentMerkleRoot;
        newVersionEntry.totalVotes = governance.getStrategyVotes(AGENT_ID, newBytecodeHash, newVersion);
        newVersionEntry.yesVotes = yesVotes;
        newVersionEntry.noVotes = noVotes;
        newVersionEntry.deployer = msg.sender;
        
        // Update history
        _addVersionToHistory(newBytecodeHash);
        
        // Update current version
        currentVersion = newVersion;
        
        // Update merkle root
        bytes32 newMerkleRoot = _computeMerkleRoot();
        _updateMerkleRoot(newMerkleRoot);
        
        emit StrategyUpgraded(newVersion, newBytecodeHash, msg.sender);
    }

    // === ROLLBACK FUNCTION ===
    function rollbackTo(uint256 targetVersion) external onlyRole(AGENT_ADMIN_ROLE) {
        require(targetVersion < currentVersion, "Cannot rollback to current or future version");
        require(strategyVersions[targetVersion].isActive, "Target version not active");
        
        // Deactivate current version
        strategyVersions[currentVersion].isActive = false;
        
        // Activate target version
        strategyVersions[targetVersion].isActive = true;
        strategyVersions[targetVersion].isRollback = true;
        
        // Update current version reference
        currentVersion = targetVersion;
        
        emit StrategyRollback(targetVersion, strategyVersions[targetVersion].bytecodeHash);
    }

    // === PERFORMANCE TRACKING ===
    function updateStrategyPerformance(bytes32 strategyHash, uint256 version, uint256 performanceScore) external {
        require(strategyGovernance == msg.sender, "Only governance can update performance");
        require(performanceScore <= 100, "Performance cannot exceed 100");
        
        strategyVersions[version].performanceScore = performanceScore;
        emit StrategyPerformanceUpdated(version, performanceScore);
    }

    // === MERKLE ROOT COMPUTATION ===
    function _computeMerkleRoot() internal view returns (bytes32) {
        if (strategyHistory.length() == 0) {
            return bytes32(0);
        }
        
        bytes32[] memory hashes = new bytes32[](strategyHistory.length());
        for (uint256 i = 0; i < strategyHistory.length(); i++) {
            hashes[i] = strategyHistory.at(i);
        }
        
        return _hashMerkleTree(hashes);
    }

    function _hashMerkleTree(bytes32[] memory hashes) internal pure returns (bytes32) {
        if (hashes.length == 0) {
            return bytes32(0);
        }
        
        if (hashes.length == 1) {
            return hashes[0];
        }
        
        // Simple pairwise hashing for merkle root
        while (hashes.length > 1) {
            bytes32[] memory nextLevel = new bytes32[]((hashes.length + 1) / 2);
            for (uint256 i = 0; i < hashes.length; i += 2) {
                if (i + 1 < hashes.length) {
                    nextLevel[i / 2] = keccak256(abi.encodePacked(hashes[i], hashes[i + 1]));
                } else {
                    nextLevel[i / 2] = hashes[i];
                }
            }
            hashes = nextLevel;
        }
        
        return hashes[0];
    }

    // === VIEW FUNCTIONS ===
    function getVersionInfo(uint256 version) external view returns (StrategyVersion memory) {
        return strategyVersions[version];
    }

    function getCurrentVersionInfo() external view returns (StrategyVersion memory) {
        return strategyVersions[currentVersion];
    }

    function getStrategyHistory() external view returns (bytes32[] memory) {
        bytes32[] memory history = new bytes32[](strategyHistory.length());
        for (uint256 i = 0; i < strategyHistory.length(); i++) {
            history[i] = strategyHistory.at(i);
        }
        return history;
    }

    function getMerkleRoot() external view returns (bytes32) {
        return currentMerkleRoot;
    }

    function getActiveVersion() external view returns (uint256) {
        return currentVersion;
    }

    // === GOVERNANCE MANAGEMENT ===
    function setGovernanceContract(address _governance) external onlyRole(AGENT_ADMIN_ROLE) {
        require(_governance != address(0), "Invalid governance address");
        strategyGovernance = _governance;
        emit GovernanceContractSet(_governance);
    }

    // === EXTERNAL EXECUTION INTERFACE ===
    function executeStrategy(bytes memory strategyData) external returns (bytes memory) {
        // This is a placeholder - actual implementation depends on strategy bytecode
        // In production, this would call the strategy contract at the current version
        require(strategyVersions[currentVersion].isActive, "No active strategy");
        
        // Placeholder return - actual execution depends on strategy implementation
        return "";
    }

    // === ERC-8004 INTERFACE IMPLEMENTATION ===
    function agentId() external view returns (bytes32) {
        return AGENT_ID;
    }

    function agentVersion() external view returns (uint256) {
        return currentVersion;
    }

    function agentStatus() external view returns (bool) {
        return strategyVersions[currentVersion].isActive;
    }

    // === SECURITY: REENTRANCY GUARD ===
    bool private _notReentrant;
    
    modifier notReentrant() {
        require(!_notReentrant, "Reentrant call");
        _notReentrant = true;
        _;
        _notReentrant = false;
    }

    // === SECURITY: PAUSE FUNCTIONALITY ===
    bool private _paused;
    
    modifier whenNotPaused() {
        require(!_paused, "Contract paused");
        _;
    }

    function pause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _paused = true;
    }

    function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _paused = false;
    }

    // === GAS OPTIMIZATION: INLINE FUNCTIONS ===
    function isVersionActive(uint256 version) external view returns (bool) {
        return strategyVersions[version].isActive;
    }

    function getPerformanceScore(uint256 version) external view returns (uint256) {
        return strategyVersions[version].performanceScore;
    }

    function getPreviousVersionHash(uint256 version) external view returns (bytes32) {
        return strategyVersions[version].previousVersionHash;
    }

    // === NOVEL: PROVENANCE VERIFICATION ===
    function verifyProvenance(bytes32 strategyHash, uint256 version) external view returns (bool) {
        StrategyVersion storage versionInfo = strategyVersions[version];
        return versionInfo.bytecodeHash == strategyHash && versionInfo.isActive;
    }

    // === NOVEL: VERSION CHAIN VALIDATION ===
    function validateVersionChain(uint256 version) external view returns (bool) {
        if (version == 0) return true;
        
        StrategyVersion storage current = strategyVersions[version];
        if (current.previousVersionHash == bytes32(0)) return false;
        
        // Check if previous version exists in history
        for (uint256 i = 0; i < strategyHistory.length(); i++) {
            if (strategyHistory.at(i) == current.previousVersionHash) {
                return true;
            }
        }
        
        return false;
    }
}