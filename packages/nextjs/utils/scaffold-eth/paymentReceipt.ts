import {
  type Address,
  type Hash,
  type TransactionReceipt,
  keccak256,
  parseAbiItem,
  parseEventLogs,
  stringToHex,
} from "viem";

const receiptIssuedEvent = parseAbiItem(
  "event ReceiptIssued(uint256 indexed callId, address indexed caller, bytes32 inputHash, uint256 blockHeight, uint256 timestamp, uint256 amount)",
);

type PaymentReceiptOptions = {
  receipt: TransactionReceipt;
  txHash: Hash;
  contractAddress: Address;
  inputText: string;
  amount: bigint;
};

export const createReceiptReadFailure = (txHash: Hash, reason: string) => ({
  isPaymentActive: false as const,
  phase: "eventReadFailed" as const,
  txHash,
  errorMessage: `交易已广播，回执读取失败：${reason}。可根据 txHash ${txHash} 人工核查；不会自动重发。`,
});

export const findPaymentReceiptEvent = ({
  receipt,
  txHash,
  contractAddress,
  inputText,
  amount,
}: PaymentReceiptOptions) => {
  if (receipt.status !== "success") throw new Error("Transaction did not succeed");
  if (
    receipt.transactionHash.toLowerCase() !== txHash.toLowerCase() ||
    receipt.to?.toLowerCase() !== contractAddress.toLowerCase()
  ) {
    return null;
  }

  const expectedInputHash = keccak256(stringToHex(inputText));
  const events = parseEventLogs({
    abi: [receiptIssuedEvent],
    eventName: "ReceiptIssued",
    logs: receipt.logs.filter(
      log =>
        log.address.toLowerCase() === contractAddress.toLowerCase() &&
        log.transactionHash?.toLowerCase() === txHash.toLowerCase(),
    ),
  });

  return (
    events.find(event => {
      const { callId, caller, inputHash, blockHeight, timestamp, amount: eventAmount } = event.args;
      return (
        callId > 0n &&
        caller.toLowerCase() === receipt.from.toLowerCase() &&
        inputHash.toLowerCase() === expectedInputHash.toLowerCase() &&
        blockHeight === receipt.blockNumber &&
        timestamp > 0n &&
        eventAmount === amount
      );
    }) ?? null
  );
};
