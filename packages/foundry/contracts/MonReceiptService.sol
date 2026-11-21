// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

contract MonReceiptService {
    error IncorrectPayment(uint256 expected, uint256 actual);
    error InvalidInputLength(uint256 length);
    error TransferFailed();

    struct Receipt {
        uint256 callId;
        address caller;
        bytes32 inputHash;
        uint256 blockHeight;
        uint256 timestamp;
    }

    uint256 public constant PRICE = 0.1 ether;
    address public immutable serviceProvider;
    uint256 public lastCallId;

    mapping(uint256 => Receipt) public receipts;

    event ReceiptIssued(
        uint256 indexed callId,
        address indexed caller,
        bytes32 inputHash,
        uint256 blockHeight,
        uint256 timestamp,
        uint256 amount
    );

    constructor(address _serviceProvider) {
        require(_serviceProvider != address(0), "Service provider cannot be zero address");
        serviceProvider = _serviceProvider;
    }

    function callService(string calldata text) external payable {
        if (msg.value != PRICE) {
            revert IncorrectPayment(PRICE, msg.value);
        }

        uint256 inputLength = bytes(text).length;
        if (inputLength == 0 || inputLength > 256) {
            revert InvalidInputLength(inputLength);
        }

        uint256 callId = lastCallId + 1;
        bytes32 inputHash = keccak256(bytes(text));

        lastCallId = callId;
        receipts[callId] = Receipt({
            callId: callId,
            caller: msg.sender,
            inputHash: inputHash,
            blockHeight: block.number,
            timestamp: block.timestamp
        });

        (bool success,) = serviceProvider.call{ value: msg.value }("");
        if (!success) {
            revert TransferFailed();
        }

        emit ReceiptIssued(callId, msg.sender, inputHash, block.number, block.timestamp, PRICE);
    }
}
