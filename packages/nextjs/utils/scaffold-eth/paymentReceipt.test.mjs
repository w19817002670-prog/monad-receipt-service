import { createReceiptReadFailure, findPaymentReceiptEvent } from "./paymentReceipt.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { encodeAbiParameters, encodeEventTopics, keccak256, parseAbiItem, stringToHex } from "viem";

const receiptIssuedEvent = parseAbiItem(
  "event ReceiptIssued(uint256 indexed callId, address indexed caller, bytes32 inputHash, uint256 blockHeight, uint256 timestamp, uint256 amount)",
);
const txHash = `0x${"11".repeat(32)}`;
const otherTxHash = `0x${"22".repeat(32)}`;
const contractAddress = "0xe9f0426a69b0f5c3f7caff7e784d04277419c441";
const otherAddress = "0x0000000000000000000000000000000000000001";
const caller = "0x0000000000000000000000000000000000000002";
const inputText = "录屏回执";
const inputHash = keccak256(stringToHex(inputText));
const amount = 100000000000000000n;

const makeLog = ({ eventArgs = {}, ...logOverrides } = {}) => {
  const args = {
    callId: 1n,
    caller,
    inputHash,
    blockHeight: 123n,
    timestamp: 456n,
    amount,
    ...eventArgs,
  };
  return {
    address: contractAddress,
    transactionHash: txHash,
    topics: encodeEventTopics({
      abi: [receiptIssuedEvent],
      eventName: "ReceiptIssued",
      args: { callId: args.callId, caller: args.caller },
    }),
    data: encodeAbiParameters(
      [{ type: "bytes32" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }],
      [args.inputHash, args.blockHeight, args.timestamp, args.amount],
    ),
    ...logOverrides,
  };
};

const makeReceipt = ({ logs = [makeLog()], ...overrides } = {}) => ({
  status: "success",
  transactionHash: txHash,
  to: contractAddress,
  from: caller,
  blockNumber: 123n,
  logs,
  ...overrides,
});

const parse = overrides =>
  findPaymentReceiptEvent({
    receipt: makeReceipt(overrides),
    txHash,
    contractAddress,
    inputText,
    amount,
  });

test("accepts the current transaction's valid ReceiptIssued log", () => {
  const event = parse();
  assert.equal(event.args.callId, 1n);
  assert.equal(event.args.caller, caller);
  assert.equal(event.args.inputHash, inputHash);
  assert.equal(event.transactionHash, txHash);
});

test("rejects a reverted transaction", () => {
  assert.throws(() => parse({ status: "reverted" }), /did not succeed/);
});

test("rejects a receipt or log from another transaction", () => {
  assert.equal(parse({ transactionHash: otherTxHash }), null);
  assert.equal(parse({ logs: [makeLog({ transactionHash: otherTxHash })] }), null);
});

test("rejects another contract in the receipt or log", () => {
  assert.equal(parse({ to: otherAddress }), null);
  assert.equal(parse({ logs: [makeLog({ address: otherAddress })] }), null);
});

test("rejects a successful transaction without ReceiptIssued", () => {
  assert.equal(parse({ logs: [] }), null);
});

test("rejects ReceiptIssued fields that do not match this payment", async t => {
  const invalidCases = [
    ["callId", { callId: 0n }],
    ["caller", { caller: otherAddress }],
    ["inputHash", { inputHash: `0x${"00".repeat(32)}` }],
    ["blockHeight", { blockHeight: 124n }],
    ["timestamp", { timestamp: 0n }],
    ["amount", { amount: amount - 1n }],
  ];

  for (const [name, eventArgs] of invalidCases) {
    await t.test(name, () => {
      assert.equal(parse({ logs: [makeLog({ eventArgs })] }), null);
    });
  }
});

const assertReceiptReadFailure = reason => {
  const failure = createReceiptReadFailure(txHash, reason);
  assert.equal(failure.isPaymentActive, false);
  assert.equal(failure.phase, "eventReadFailed");
  assert.equal(failure.txHash, txHash);
  assert.match(failure.errorMessage, /交易已广播，回执读取失败/);
  assert.match(failure.errorMessage, /人工核查/);
  assert.ok(failure.errorMessage.includes(reason));
  assert.ok(failure.errorMessage.includes(txHash));
};

test("publicClient unavailable unlocks payment and preserves the real txHash", () => {
  assertReceiptReadFailure("链上客户端未就绪");
});

test("deployedContract unavailable unlocks payment and preserves the real txHash", () => {
  assertReceiptReadFailure("合约信息暂未加载");
});

test("receipt wait failure unlocks payment and preserves the real txHash", () => {
  assertReceiptReadFailure("receipt temporarily unavailable");
});
