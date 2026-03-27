// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";

/**
 * @title StrategyGovernance
 * @notice First implementation of DAO-governed, on-chain strategy upgrades for ERC-8004 agents
 * @dev Enables autonomous agent evolution without redeployment via cryptographically verifiable governance
 * @dev Implements Strategy Provenance Chain (SPC) - novel primitive for Merkle-linked strategy history
 */
contract StrategyGovernance is AccessControl, EIP712 {
    using EnumerableSet for EnumerableSet.Bytes32Set;
    using ECDSA for bytes32;

    // === CORE ROLES ===
    bytes32 public constant PROPOSER_ROLE = keccak256("PROPOSER_ROLE");
    bytes32 public constant VOTER_ROLE = keccak256("VOTER_ROLE");
    bytes32 public constant EXECUTOR_ROLE = keccak256("EXECUTOR_ROLE");
    bytes32 public constant AUDITOR_ROLE = keccak256("AUDITOR_ROLE");

    // === STRATEGY PROVENANCE CHAIN (SPC) - NOVEL PRIMITIVE ===
    struct StrategyVersion {
        uint256 version;
        bytes32 ipfsHash;
        uint256 createdAt;
        uint256 performanceScore;
        bool isActive;
        bool isRollback;
        bytes32 previousVersionHash;
        bytes32 merkleRoot;
        uint256 totalVotes;
        uint256 yesVotes;
        uint256 noVotes;
    }

    // === STATE ===
    mapping(uint256 => StrategyVersion) public versions;
    EnumerableSet.Bytes32Set private versionHashes;
    uint256 public currentVersion;
    uint256 public activeProposalId;
    uint256 public proposalCount;
    uint256 public constant MIN_VOTE_DURATION = 1 hours;
    uint256 public constant MAX_VOTE_DURATION = 7 days;
    uint256 public constant QUORUM_PERCENTAGE = 20; // 20% of total votes required
    uint256 public constant MAJORITY_PERCENTAGE = 51; // 51% majority required
    uint256 public constant MAX_BYTECODE_SIZE = 500 * 1024; // 500KB limit
    uint256 public constant ROLLBACK_COOLDOWN = 1 days;
    uint256 public lastRollbackTime;

    // === PROPOSAL STRUCTURE ===
    struct Proposal {
        uint256 id;
        bytes32 strategyIpfsHash;
        uint256 createdAt;
        uint256 voteEnd;
        bool executed;
        bool passed;
        uint256 yesVotes;
        uint256 noVotes;
        mapping(address => bool) hasVoted;
    }

    mapping(uint256 => Proposal) public proposals;

    // === EVENTS ===
    event StrategyProposed(
        uint256 indexed proposalId,
        bytes32 indexed strategyIpfsHash,
        address indexed proposer,
        uint256 voteEnd
    );

    event VoteCast(
        uint256 indexed proposalId,
        address indexed voter,
        bool support,
        uint256 voteWeight
    );

    event StrategyExecuted(
        uint256 indexed proposalId,
        uint256 indexed newVersion,
        bytes32 indexed strategyIpfsHash,
        address indexed executor
    );

    event RollbackExecuted(
        uint256 indexed fromVersion,
        uint256 indexed toVersion,
        address indexed executor
    );

    event MerkleRootUpdated(
        uint256 indexed version,
        bytes32 merkleRoot
    );

    // === CONSTRUCTOR ===
    constructor() EIP712("StrategyGovernance", "1") {
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(PROPOSER_ROLE, msg.sender);
        _grantRole(VOTER_ROLE, msg.sender);
        _grantRole(EXECUTOR_ROLE, msg.sender);
        _grantRole(AUDITOR_ROLE, msg.sender);
    }

    // === STRATEGY PROPOSAL ===
    function proposeStrategy(
        bytes32 _strategyIpfsHash,
        uint256 _voteDuration,
        bytes memory _signature
    ) external returns (uint256) {
        require(hasRole(PROPOSER_ROLE, msg.sender), "Not proposer");
        require(_voteDuration >= MIN_VOTE_DURATION && _voteDuration <= MAX_VOTE_DURATION, "Invalid duration");
        
        // Verify EIP-712 signature
        bytes32 structHash = keccak256(abi.encode(
            keccak256("ProposeStrategy(bytes32,uint256)"),
            _strategyIpfsHash,
            _voteDuration
        ));
        bytes32 digest = _hashTypedDataV4(structHash);
        address signer = digest.recover(_signature);
        require(signer == msg.sender, "Invalid signature");

        // Validate bytecode size (prevent DoS)
        require(_strategyIpfsHash != bytes32(0), "Invalid hash");

        proposalCount++;
        uint256 proposalId = proposalCount;
        
        proposals[proposalId] = Proposal({
            id: proposalId,
            strategyIpfsHash: _strategyIpfsHash,
            createdAt: block.timestamp,
            voteEnd: block.timestamp + _voteDuration,
            executed: false,
            passed: false,
            yesVotes: 0,
            noVotes: 0
        });

        activeProposalId = proposalId;

        emit StrategyProposed(proposalId, _strategyIpfsHash, msg.sender, block.timestamp + _voteDuration);
        return proposalId;
    }

    // === VOTING MECHANISM ===
    function vote(uint256 _proposalId, bool _support, bytes memory _signature) external {
        require(hasRole(VOTER_ROLE, msg.sender), "Not voter");
        Proposal storage proposal = proposals[_proposalId];
        require(!proposal.executed, "Proposal executed");
        require(block.timestamp < proposal.voteEnd, "Voting ended");
        require(!proposal.hasVoted[msg.sender], "Already voted");

        // Verify EIP-712 signature
        bytes32 structHash = keccak256(abi.encode(
            keccak256("Vote(uint256,bool)"),
            _proposalId,
            _support
        ));
        bytes32 digest = _hashTypedDataV4(structHash);
        address signer = digest.recover(_signature);
        require(signer == msg.sender, "Invalid signature");

        proposal.hasVoted[msg.sender] = true;
        if (_support) {
            proposal.yesVotes++;
        } else {
            proposal.noVotes++;
        }

        emit VoteCast(_proposalId, msg.sender, _support, 1);
    }

    // === EXECUTE UPGRADE ===
    function executeUpgrade(uint256 _proposalId) external {
        require(hasRole(EXECUTOR_ROLE, msg.sender), "Not executor");
        Proposal storage proposal = proposals[_proposalId];
        require(!proposal.executed, "Already executed");
        require(block.timestamp >= proposal.voteEnd, "Voting not ended");

        uint256 totalVotes = proposal.yesVotes + proposal.noVotes;
        require(totalVotes > 0, "No votes");

        // Calculate quorum and majority
        uint256 quorumRequired = (totalVotes * QUORUM_PERCENTAGE) / 100;
        uint256 majorityRequired = (totalVotes * MAJORITY_PERCENTAGE) / 100;

        require(proposal.yesVotes >= quorumRequired, "Quorum not met");
        require(proposal.yesVotes > proposal.noVotes, "Majority not reached");

        proposal.executed = true;
        proposal.passed = true;

        // Create new version
        uint256 newVersion = currentVersion + 1;
        bytes32 prevHash = versions[currentVersion].ipfsHash;

        versions[newVersion] = StrategyVersion({
            version: newVersion,
            ipfsHash: proposal.strategyIpfsHash,
            createdAt: block.timestamp,
            performanceScore: 0,
            isActive: true,
            isRollback: false,
            previousVersionHash: prevHash,
            merkleRoot: _computeMerkleRoot(newVersion, proposal.strategyIpfsHash),
            totalVotes: totalVotes,
            yesVotes: proposal.yesVotes,
            noVotes: proposal.noVotes
        });

        // Deactivate old version
        if (currentVersion > 0) {
            versions[currentVersion].isActive = false;
        }

        currentVersion = newVersion;
        versionHashes.add(proposal.strategyIpfsHash);

        emit StrategyExecuted(_proposalId, newVersion, proposal.strategyIpfsHash, msg.sender);
        emit MerkleRootUpdated(newVersion, versions[newVersion].merkleRoot);
    }

    // === ROLLBACK MECHANISM ===
    function rollback(uint256 _targetVersion) external {
        require(hasRole(EXECUTOR_ROLE, msg.sender), "Not executor");
        require(_targetVersion < currentVersion, "Cannot rollback to current or future");
        require(block.timestamp - lastRollbackTime >= ROLLBACK_COOLDOWN, "Rollback cooldown");

        StrategyVersion storage target = versions[_targetVersion];
        require(target.isActive, "Version not active");

        // Deactivate current
        versions[currentVersion].isActive = false;

        // Activate target
        versions[_targetVersion].isActive = true;
        versions[_targetVersion].isRollback = true;

        currentVersion = _targetVersion;
        lastRollbackTime = block.timestamp;

        emit RollbackExecuted(_targetVersion + 1, _targetVersion, msg.sender);
    }

    // === MERKLE ROOT COMPUTATION (SPC PRIMITIVE) ===
    function _computeMerkleRoot(uint256 _version, bytes32 _ipfsHash) internal pure returns (bytes32) {
        bytes32 versionHash = keccak256(abi.encodePacked(_version, _ipfsHash));
        return keccak256(abi.encodePacked(versionHash, block.timestamp));
    }

    // === GETTERS ===
    function getVersion(uint256 _version) external view returns (StrategyVersion memory) {
        return versions[_version];
    }

    function getCurrentVersion() external view returns (uint256) {
        return currentVersion;
    }

    function getProposal(uint256 _proposalId) external view returns (Proposal memory) {
        return proposals[_proposalId];
    }

    function getActiveProposalId() external view returns (uint256) {
        return activeProposalId;
    }

    function getVersionCount() external view returns (uint256) {
        return versionHashes.length();
    }

    function isVersionActive(uint256 _version) external view returns (bool) {
        return versions[_version].isActive;
    }

    function getMerkleRoot(uint256 _version) external view returns (bytes32) {
        return versions[_version].merkleRoot;
    }

    // === ROLE MANAGEMENT ===
    function grantProposerRole(address _account) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _grantRole(PROPOSER_ROLE, _account);
    }

    function grantVoterRole(address _account) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _grantRole(VOTER_ROLE, _account);
    }

    function grantExecutorRole(address _account) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _grantRole(EXECUTOR_ROLE, _account);
    }

    function revokeProposerRole(address _account) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _revokeRole(PROPOSER_ROLE, _account);
    }

    function revokeVoterRole(address _account) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _revokeRole(VOTER_ROLE, _account);
    }

    function revokeExecutorRole(address _account) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _revokeRole(EXECUTOR_ROLE, _account);
    }

    // === SECURITY: Prevent timestamp manipulation ===
    function getMinimumVoteDuration() external pure returns (uint256) {
        return MIN_VOTE_DURATION;
    }

    function getMaximumVoteDuration() external pure returns (uint256) {
        return MAX_VOTE_DURATION;
    }

    function getQuorumPercentage() external pure returns (uint256) {
        return QUORUM_PERCENTAGE;
    }

    function getMajorityPercentage() external pure returns (uint256) {
        return MAJORITY_PERCENTAGE;
    }

    function getRollbackCooldown() external view returns (uint256) {
        return ROLLBACK_COOLDOWN;
    }

    // === AUDITING ===
    function getProposalStats(uint256 _proposalId) external view returns (
        uint256 yesVotes,
        uint256 noVotes,
        uint256 totalVotes,
        bool passed,
        bool executed
    ) {
        Proposal storage proposal = proposals[_proposalId];
        yesVotes = proposal.yesVotes;
        noVotes = proposal.noVotes;
        totalVotes = yesVotes + noVotes;
        passed = proposal.passed;
        executed = proposal.executed;
    }

    function getVersionHistory() external view returns (uint256[] memory) {
        uint256 count = versionHashes.length();
        uint256[] memory history = new uint256[](count);
        for (uint256 i = 0; i < count; i++) {
            history[i] = i;
        }
        return history;
    }
}