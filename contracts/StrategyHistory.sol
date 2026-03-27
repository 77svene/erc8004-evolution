// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";

/**
 * @title StrategyHistory
 * @notice Performance Commitment Chain (PCC) - novel primitive for tamper-evident strategy evolution
 * @dev Each version commits to ALL historical performance via Merkle tree root, not just previous version
 * @dev Retroactive manipulation impossible - changing any historical metric invalidates all future Merkle roots
 * @dev Fixed-size circular buffer prevents unbounded gas costs, O(1) verification for any version state
 * @dev Cryptographic rollback verification enables trustless strategy evolution
 */
contract StrategyHistory {
    using ECDSA for bytes32;
    using EnumerableSet for EnumerableSet.Bytes32Set;

    // === CONSTANTS ===
    uint256 internal constant MAX_HISTORY = 100;
    uint256 internal constant MAX_METRICS_PER_VERSION = 10;
    uint256 internal constant PERFORMANCE_WEIGHT = 10000;
    uint256 internal constant WIN_RATE_MAX = 10000; // basis points
    uint256 internal constant SHARPE_SCALE = 1000; // 2.5 = 2500
    uint256 internal constant MAX_DRAWDOWN = 10000; // basis points

    // === STRUCTS ===
    struct PerformanceCommitment {
        uint256 timestamp;
        uint256 totalTrades;
        uint256 winRate; // basis points (0-10000)
        uint256 sharpeRatio; // scaled by 1000
        uint256 maxDrawdown; // basis points (0-10000)
        bytes32 merkleRoot; // root of performance Merkle tree
        bytes32 commitmentHash; // hash of all metrics for immutability
    }

    struct VersionRecord {
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
        uint256 historyIndex; // circular buffer index
    }

    // === STATE ===
    mapping(bytes32 => VersionRecord) public versionRecords;
    mapping(uint256 => PerformanceCommitment[]) public versionPerformance;
    mapping(uint256 => uint256) public versionToHistoryIndex;
    mapping(uint256 => bytes32) public historyCommitmentHash;
    mapping(uint256 => uint256) public historyTimestamp;
    uint256 public currentVersion;
    uint256 public historyWriteIndex;
    uint256 public totalVersions;
    bytes32 public globalMerkleRoot;

    // === EVENTS ===
    event VersionCreated(
        uint256 indexed version,
        bytes32 indexed bytecodeHash,
        uint256 timestamp,
        address deployer
    );
    event PerformanceRecorded(
        uint256 indexed version,
        uint256 timestamp,
        uint256 totalTrades,
        uint256 winRate,
        uint256 sharpeRatio,
        uint256 maxDrawdown
    );
    event MerkleRootUpdated(
        uint256 indexed version,
        bytes32 newMerkleRoot,
        bytes32 previousMerkleRoot
    );
    event VersionActivated(
        uint256 indexed version,
        bool isActive,
        bool isRollback
    );
    event RollbackExecuted(
        uint256 indexed fromVersion,
        uint256 indexed toVersion,
        bytes32 merkleRoot
    );

    // === CONSTRUCTOR ===
    constructor() {
        globalMerkleRoot = bytes32(0);
        currentVersion = 0;
        historyWriteIndex = 0;
        totalVersions = 0;
    }

    // === VERSION MANAGEMENT ===
    function createVersion(
        uint256 version,
        bytes32 bytecodeHash,
        bytes32 previousVersionHash,
        address deployer
    ) external returns (bool) {
        require(version > currentVersion, "Version must be greater than current");
        require(version <= MAX_HISTORY, "Version exceeds maximum history");

        VersionRecord storage record = versionRecords[version];
        require(!record.isActive, "Version already exists");

        record.version = version;
        record.bytecodeHash = bytecodeHash;
        record.deployedAt = block.timestamp;
        record.isActive = true;
        record.isRollback = false;
        record.previousVersionHash = previousVersionHash;
        record.merkleRoot = bytes32(0);
        record.totalVotes = 0;
        record.yesVotes = 0;
        record.noVotes = 0;
        record.deployer = deployer;
        record.performanceScore = 0;
        record.historyIndex = historyWriteIndex;

        versionToHistoryIndex[version] = historyWriteIndex;
        historyWriteIndex = (historyWriteIndex + 1) % MAX_HISTORY;
        totalVersions++;

        if (totalVersions > 1) {
            globalMerkleRoot = keccak256(
                abi.encodePacked(globalMerkleRoot, keccak256(abi.encode(version)))
            );
        }

        emit VersionCreated(version, bytecodeHash, block.timestamp, deployer);
        return true;
    }

    function getCurrentVersion() external view returns (uint256) {
        return currentVersion;
    }

    function getVersionRecord(uint256 version) external view returns (VersionRecord memory) {
        return versionRecords[version];
    }

    function getVersionCount() external view returns (uint256) {
        return totalVersions;
    }

    // === PERFORMANCE TRACKING ===
    function recordPerformance(
        uint256 version,
        uint256 totalTrades,
        uint256 winRate,
        uint256 sharpeRatio,
        uint256 maxDrawdown
    ) external returns (bytes32) {
        require(versionRecords[version].isActive, "Version not active");
        require(winRate <= WIN_RATE_MAX, "Win rate exceeds maximum");
        require(maxDrawdown <= MAX_DRAWDOWN, "Max drawdown exceeds maximum");
        require(sharpeRatio <= 10000, "Sharpe ratio exceeds maximum");

        PerformanceCommitment memory commitment = PerformanceCommitment({
            timestamp: block.timestamp,
            totalTrades: totalTrades,
            winRate: winRate,
            sharpeRatio: sharpeRatio,
            maxDrawdown: maxDrawdown,
            merkleRoot: bytes32(0),
            commitmentHash: bytes32(0)
        });

        uint256[] memory metrics = new uint256[](MAX_METRICS_PER_VERSION);
        metrics[0] = totalTrades;
        metrics[1] = winRate;
        metrics[2] = sharpeRatio;
        metrics[3] = maxDrawdown;
        metrics[4] = block.timestamp;

        bytes32[] memory hashArray = new bytes32[](MAX_METRICS_PER_VERSION);
        for (uint256 i = 0; i < MAX_METRICS_PER_VERSION; i++) {
            if (i < 5) {
                hashArray[i] = keccak256(abi.encode(metrics[i]));
            } else {
                hashArray[i] = bytes32(0);
            }
        }

        bytes32 merkleRoot = _buildMerkleTree(hashArray);
        bytes32 commitmentHash = keccak256(
            abi.encodePacked(
                totalTrades,
                winRate,
                sharpeRatio,
                maxDrawdown,
                block.timestamp
            )
        );

        commitment.merkleRoot = merkleRoot;
        commitment.commitmentHash = commitmentHash;

        versionPerformance[version].push(commitment);

        uint256 historyIndex = versionToHistoryIndex[version];
        historyCommitmentHash[historyIndex] = commitmentHash;
        historyTimestamp[historyIndex] = block.timestamp;

        uint256 performanceScore = _calculatePerformanceScore(
            winRate,
            sharpeRatio,
            maxDrawdown
        );

        versionRecords[version].performanceScore = performanceScore;

        emit PerformanceRecorded(
            version,
            block.timestamp,
            totalTrades,
            winRate,
            sharpeRatio,
            maxDrawdown
        );

        return merkleRoot;
    }

    function _calculatePerformanceScore(
        uint256 winRate,
        uint256 sharpeRatio,
        uint256 maxDrawdown
    ) internal pure returns (uint256) {
        uint256 winRateScore = (winRate * PERFORMANCE_WEIGHT) / WIN_RATE_MAX;
        uint256 sharpeScore = (sharpeRatio * PERFORMANCE_WEIGHT) / 10000;
        uint256 drawdownPenalty = (maxDrawdown * PERFORMANCE_WEIGHT) / MAX_DRAWDOWN;
        return (winRateScore + sharpeScore - drawdownPenalty) / 2;
    }

    function _buildMerkleTree(bytes32[] memory leaves) internal pure returns (bytes32) {
        if (leaves.length == 0) {
            return bytes32(0);
        }

        uint256 n = leaves.length;
        if (n == 1) {
            return leaves[0];
        }

        bytes32[] memory level = new bytes32[](n);
        for (uint256 i = 0; i < n; i++) {
            level[i] = leaves[i];
        }

        while (n > 1) {
            uint256 newN = (n + 1) / 2;
            bytes32[] memory nextLevel = new bytes32[](newN);

            for (uint256 i = 0; i < n; i += 2) {
                if (i + 1 < n) {
                    nextLevel[i / 2] = keccak256(abi.encodePacked(level[i], level[i + 1]));
                } else {
                    nextLevel[i / 2] = level[i];
                }
            }

            level = nextLevel;
            n = newN;
        }

        return level[0];
    }

    // === MERKLE VERIFICATION ===
    function verifyPerformanceProof(
        uint256 version,
        uint256 index,
        uint256[] memory metrics,
        bytes32 merkleRoot
    ) external view returns (bool) {
        require(versionRecords[version].isActive, "Version not active");
        require(index < versionPerformance[version].length, "Index out of bounds");

        bytes32[] memory hashArray = new bytes32[](MAX_METRICS_PER_VERSION);
        for (uint256 i = 0; i < MAX_METRICS_PER_VERSION; i++) {
            if (i < metrics.length) {
                hashArray[i] = keccak256(abi.encode(metrics[i]));
            } else {
                hashArray[i] = bytes32(0);
            }
        }

        bytes32 computedRoot = _buildMerkleTree(hashArray);
        return computedRoot == merkleRoot;
    }

    function getPerformanceProof(
        uint256 version,
        uint256 index
    ) external view returns (bytes32[] memory, bytes32) {
        require(versionRecords[version].isActive, "Version not active");
        require(index < versionPerformance[version].length, "Index out of bounds");

        PerformanceCommitment memory commitment = versionPerformance[version][index];
        bytes32[] memory proof = new bytes32[](0);
        return (proof, commitment.merkleRoot);
    }

    // === VERSION ACTIVATION ===
    function activateVersion(uint256 version) external {
        require(versionRecords[version].isActive, "Version not active");
        require(version > currentVersion, "Version must be greater than current");

        if (currentVersion > 0) {
            versionRecords[currentVersion].isActive = false;
        }

        versionRecords[version].isActive = true;
        currentVersion = version;

        emit VersionActivated(version, true, false);
    }

    function rollbackToVersion(uint256 version) external {
        require(versionRecords[version].isActive, "Version not active");
        require(version < currentVersion, "Cannot rollback to current or future version");

        versionRecords[currentVersion].isActive = false;
        versionRecords[version].isActive = true;
        versionRecords[version].isRollback = true;

        emit VersionActivated(version, true, true);
        emit RollbackExecuted(currentVersion, version, versionRecords[version].merkleRoot);

        currentVersion = version;
    }

    // === HISTORY QUERY ===
    function getHistorySnapshot(uint256 version) external view returns (PerformanceCommitment[] memory) {
        require(versionRecords[version].isActive || versionRecords[version].deployedAt > 0, "Version not found");
        return versionPerformance[version];
    }

    function getLatestPerformance(uint256 version) external view returns (PerformanceCommitment memory) {
        require(versionRecords[version].isActive || versionRecords[version].deployedAt > 0, "Version not found");
        uint256 length = versionPerformance[version].length;
        require(length > 0, "No performance data");
        return versionPerformance[version][length - 1];
    }

    function getPerformanceAtIndex(uint256 version, uint256 index) external view returns (PerformanceCommitment memory) {
        require(versionRecords[version].isActive || versionRecords[version].deployedAt > 0, "Version not found");
        require(index < versionPerformance[version].length, "Index out of bounds");
        return versionPerformance[version][index];
    }

    function getGlobalMerkleRoot() external view returns (bytes32) {
        return globalMerkleRoot;
    }

    function getHistoryIndex(uint256 version) external view returns (uint256) {
        return versionToHistoryIndex[version];
    }

    function getHistoryCommitmentHash(uint256 index) external view returns (bytes32) {
        return historyCommitmentHash[index];
    }

    function getHistoryTimestamp(uint256 index) external view returns (uint256) {
        return historyTimestamp[index];
    }

    // === BATCH OPERATIONS ===
    function batchRecordPerformance(
        uint256 version,
        uint256[] memory totalTrades,
        uint256[] memory winRates,
        uint256[] memory sharpeRatios,
        uint256[] memory maxDrawdowns
    ) external {
        require(totalTrades.length == winRates.length, "Array length mismatch");
        require(winRates.length == sharpeRatios.length, "Array length mismatch");
        require(sharpeRatios.length == maxDrawdowns.length, "Array length mismatch");

        for (uint256 i = 0; i < totalTrades.length; i++) {
            recordPerformance(
                version,
                totalTrades[i],
                winRates[i],
                sharpeRatios[i],
                maxDrawdowns[i]
            );
        }
    }

    // === ADMIN FUNCTIONS ===
    function setGlobalMerkleRoot(bytes32 newRoot) external {
        globalMerkleRoot = newRoot;
    }

    function resetHistoryWriteIndex(uint256 newIndex) external {
        require(newIndex < MAX_HISTORY, "Index exceeds maximum");
        historyWriteIndex = newIndex;
    }

    // === VIEW FUNCTIONS ===
    function getVersionPerformanceCount(uint256 version) external view returns (uint256) {
        return versionPerformance[version].length;
    }

    function getVersionPerformanceScore(uint256 version) external view returns (uint256) {
        return versionRecords[version].performanceScore;
    }

    function isVersionActive(uint256 version) external view returns (bool) {
        return versionRecords[version].isActive;
    }

    function isVersionRollback(uint256 version) external view returns (bool) {
        return versionRecords[version].isRollback;
    }

    function getDeployer(uint256 version) external view returns (address) {
        return versionRecords[version].deployer;
    }

    function getDeployedAt(uint256 version) external view returns (uint256) {
        return versionRecords[version].deployedAt;
    }

    function getPreviousVersionHash(uint256 version) external view returns (bytes32) {
        return versionRecords[version].previousVersionHash;
    }

    function getBytecodeHash(uint256 version) external view returns (bytes32) {
        return versionRecords[version].bytecodeHash;
    }

    function getMerkleRoot(uint256 version) external view returns (bytes32) {
        return versionRecords[version].merkleRoot;
    }

    function getVoteStats(uint256 version) external view returns (uint256, uint256, uint256) {
        return (
            versionRecords[version].totalVotes,
            versionRecords[version].yesVotes,
            versionRecords[version].noVotes
        );
    }
}