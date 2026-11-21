"use client";

import { useMemo, useRef, useState } from "react";
import type { NextPage } from "next";
import { TransactionReceipt, formatEther, parseEther } from "viem";
import { usePublicClient } from "wagmi";
import {
  useDeployedContractInfo,
  useScaffoldEventHistory,
  useScaffoldReadContract,
  useScaffoldWriteContract,
  useTargetNetwork,
} from "~~/hooks/scaffold-eth";
import { createReceiptReadFailure, findPaymentReceiptEvent } from "~~/utils/scaffold-eth/paymentReceipt";

type PaymentPhase =
  | "idle"
  | "awaitingSignature"
  | "awaitingConfirmation"
  | "confirmed"
  | "receiptLoaded"
  | "preflightFailed"
  | "userRejected"
  | "broadcastFailed"
  | "eventReadFailed"
  | "networkChanged";

const LOCAL_CHAIN_ID = 31337;
const MONAD_TESTNET_CHAIN_ID = 10143;
// After deployment, set this from blockNumber in the real Monad testnet broadcast receipt.
const MONAD_TESTNET_DEPLOYMENT_BLOCK: bigint | undefined = 81521306n;

const getErrorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

const isUserRejection = (message: string) =>
  /user rejected|user denied|rejected the request|denied transaction/i.test(message);

const Home: NextPage = () => {
  const [text, setText] = useState("");
  const [phase, setPhase] = useState<PaymentPhase>("idle");
  const [errorMessage, setErrorMessage] = useState("");
  const [txHash, setTxHash] = useState<`0x${string}`>();
  const activeTxHash = useRef<`0x${string}` | undefined>(undefined);
  const activeChainId = useRef<number | undefined>(undefined);
  const isPaymentActive = useRef(false);
  const { targetNetwork } = useTargetNetwork();
  const publicClient = usePublicClient({ chainId: targetNetwork.id });
  const latestChainId = useRef(targetNetwork.id);
  latestChainId.current = targetNetwork.id;
  const inputByteLength = new TextEncoder().encode(text).length;
  const isValidInput = inputByteLength >= 1 && inputByteLength <= 256;
  const isMonadTestnet = targetNetwork.id === MONAD_TESTNET_CHAIN_ID;
  const isEventHistoryEnabled =
    targetNetwork.id === LOCAL_CHAIN_ID || (isMonadTestnet && MONAD_TESTNET_DEPLOYMENT_BLOCK !== undefined);

  const { data: price } = useScaffoldReadContract({
    contractName: "MonReceiptService",
    functionName: "PRICE",
  });
  const { data: lastCallId } = useScaffoldReadContract({
    contractName: "MonReceiptService",
    functionName: "lastCallId",
  });
  const {
    data: receiptEvents,
    isLoading: isLoadingEvents,
    error: eventError,
  } = useScaffoldEventHistory({
    contractName: "MonReceiptService",
    eventName: "ReceiptIssued",
    fromBlock: targetNetwork.id === LOCAL_CHAIN_ID ? 0n : (MONAD_TESTNET_DEPLOYMENT_BLOCK ?? 1n),
    watch: true,
    enabled: isEventHistoryEnabled,
  });
  const validReceiptEvents = useMemo(
    () =>
      receiptEvents?.filter((event): event is NonNullable<typeof event> =>
        Boolean(event?.args && event.transactionHash),
      ),
    [receiptEvents],
  );
  const { writeContractAsync, isMining } = useScaffoldWriteContract({
    contractName: "MonReceiptService",
  });
  const { data: deployedContract } = useDeployedContractInfo({ contractName: "MonReceiptService" });

  const isProcessing =
    isMining || phase === "awaitingSignature" || phase === "awaitingConfirmation" || phase === "confirmed";
  const visibleEventError = phase === "networkChanged" || isPaymentActive.current ? null : eventError;

  const payForService = async (value: bigint) => {
    if (isPaymentActive.current) return;
    if (isMonadTestnet && MONAD_TESTNET_DEPLOYMENT_BLOCK === undefined) {
      setPhase("preflightFailed");
      setErrorMessage("Monad 测试网部署区块尚未配置；请从真实部署回执的 blockNumber 更新配置后再调用。");
      return;
    }

    isPaymentActive.current = true;
    activeChainId.current = targetNetwork.id;
    activeTxHash.current = undefined;
    setTxHash(undefined);
    setErrorMessage("");
    setPhase("awaitingSignature");

    let hash: `0x${string}` | undefined;
    let transactionReceipt: TransactionReceipt | undefined;
    try {
      hash = await writeContractAsync(
        {
          functionName: "callService",
          args: [text],
          value,
        },
        {
          onSuccess: submittedHash => {
            activeTxHash.current = submittedHash;
            setTxHash(submittedHash);
            setPhase("awaitingConfirmation");
          },
          onBlockConfirmation: receipt => {
            transactionReceipt = receipt;
          },
        },
      );
    } catch (error) {
      const message = getErrorMessage(error);
      isPaymentActive.current = false;
      setErrorMessage(message);
      if (activeTxHash.current) {
        setPhase("broadcastFailed");
      } else if (isUserRejection(message)) {
        setPhase("userRejected");
      } else {
        setPhase("preflightFailed");
      }
      return;
    }

    if (!hash) {
      isPaymentActive.current = false;
      setPhase("preflightFailed");
      setErrorMessage("未发起交易，请连接钱包并切换到目标网络。");
      return;
    }

    activeTxHash.current = hash;
    setTxHash(hash);
    setPhase("awaitingConfirmation");
    const failReceiptRead = (reason: string) => {
      const failure = createReceiptReadFailure(hash, reason);
      isPaymentActive.current = failure.isPaymentActive;
      setTxHash(failure.txHash);
      setErrorMessage(failure.errorMessage);
      setPhase(failure.phase);
    };
    try {
      if (!transactionReceipt) {
        if (!publicClient) {
          failReceiptRead("链上客户端未就绪");
          return;
        }
        transactionReceipt = await publicClient.waitForTransactionReceipt({ hash });
      }
      if (!isPaymentActive.current || activeTxHash.current !== hash) return;
      if (activeChainId.current !== latestChainId.current) {
        isPaymentActive.current = false;
        setPhase("networkChanged");
        return;
      }
      if (transactionReceipt.status === "reverted") {
        isPaymentActive.current = false;
        setErrorMessage("交易执行失败（reverted）。");
        setPhase("broadcastFailed");
        return;
      }
      if (!deployedContract) {
        failReceiptRead("合约信息暂未加载");
        return;
      }

      setPhase("confirmed");
      const receiptEvent = findPaymentReceiptEvent({
        receipt: transactionReceipt,
        txHash: hash,
        contractAddress: deployedContract.address,
        inputText: text,
        amount: value,
      });
      if (!receiptEvent) {
        isPaymentActive.current = false;
        setErrorMessage("本次交易回执中未找到字段匹配的 ReceiptIssued 事件。");
        setPhase("eventReadFailed");
        return;
      }

      isPaymentActive.current = false;
      setPhase("receiptLoaded");
    } catch (error) {
      if (!isPaymentActive.current || activeTxHash.current !== hash) return;
      if (activeChainId.current !== latestChainId.current) {
        isPaymentActive.current = false;
        setPhase("networkChanged");
        return;
      }
      if (!transactionReceipt) {
        failReceiptRead(getErrorMessage(error));
        return;
      }

      isPaymentActive.current = false;
      setErrorMessage(getErrorMessage(error));
      setPhase("eventReadFailed");
    }
  };

  const statusMessage = {
    idle: "",
    awaitingSignature: "正在进行链上预检；预检通过后等待用户签名。",
    awaitingConfirmation: "交易已广播，等待确认。",
    confirmed: "交易已确认，正在从链上读取 ReceiptIssued 回执。",
    receiptLoaded: "成功，并已从链上读到回执。",
    preflightFailed: `预检失败，通常没有 tx hash：${errorMessage}`,
    userRejected: `用户拒绝签名：${errorMessage}`,
    broadcastFailed: `已广播但确认失败：${errorMessage}`,
    eventReadFailed: `交易已确认，但链上回执读取失败：${errorMessage}`,
    networkChanged: "网络已切换；交易可能已经发送，请先在钱包或浏览器核实，不要直接重复支付。",
  }[phase];

  return (
    <main className="mx-auto flex w-full max-w-4xl grow flex-col gap-6 px-5 py-10">
      <section className="rounded-3xl bg-base-100 p-8 shadow">
        <p className="mb-2 text-sm uppercase tracking-wide text-primary">链上服务</p>
        <h1 className="text-3xl font-bold">MON 按次付费链上回执服务</h1>
        <p className="mt-4 text-lg">
          固定价格：
          <span className="font-mono font-bold">{price === undefined ? "0.1" : formatEther(price)} MON/次</span>
        </p>
        <p className="mt-2 text-sm text-base-content/70">每次调用支付一次，成功后在链上保存并发出回执。</p>
      </section>

      <section className="rounded-3xl bg-base-100 p-8 shadow">
        <h2 className="text-2xl font-bold">输入并支付</h2>
        <label className="form-control mt-5">
          <span className="label-text mb-2">输入文本</span>
          <textarea
            className="textarea textarea-bordered min-h-32 w-full font-mono"
            value={text}
            disabled={isProcessing}
            onChange={event => setText(event.target.value)}
            placeholder="输入 1–256 字节的 UTF-8 文本"
          />
        </label>
        <div className="mt-2 flex items-center justify-between gap-4 text-sm">
          <span className={isValidInput ? "text-success" : "text-error"}>UTF-8 字节数：{inputByteLength} / 256</span>
          {!isValidInput && <span className="text-error">请输入 1–256 字节</span>}
        </div>
        <div className="mt-5 flex flex-col gap-3 sm:flex-row">
          <button
            className="btn btn-primary flex-1"
            disabled={!isValidInput || isProcessing}
            onClick={() => payForService(parseEther("0.1"))}
          >
            支付 0.1 MON 并调用
          </button>
          <button
            className="btn btn-outline flex-1"
            disabled={!isValidInput || isProcessing}
            onClick={() => payForService(parseEther("0.05"))}
          >
            演示少付 0.05 MON
          </button>
        </div>
        {phase !== "idle" && (
          <div
            className={`mt-5 rounded-xl p-4 text-sm ${
              phase === "receiptLoaded"
                ? "bg-success/10 text-success"
                : phase === "preflightFailed" ||
                    phase === "userRejected" ||
                    phase === "broadcastFailed" ||
                    phase === "eventReadFailed" ||
                    phase === "networkChanged"
                  ? "bg-error/10 text-error"
                  : "bg-info/10 text-info"
            }`}
            role="status"
          >
            <p className="break-words">{statusMessage}</p>
            {(phase === "awaitingConfirmation" ||
              phase === "confirmed" ||
              phase === "receiptLoaded" ||
              phase === "broadcastFailed" ||
              phase === "eventReadFailed" ||
              phase === "networkChanged") &&
              txHash && <p className="mt-2 break-all font-mono">tx hash：{txHash}</p>}
          </div>
        )}
      </section>

      <section className="rounded-3xl bg-base-100 p-8 shadow">
        <div className="flex items-end justify-between gap-4">
          <h2 className="text-2xl font-bold">回执记录</h2>
          <span className="text-sm text-base-content/70">链上 lastCallId：{lastCallId?.toString() ?? "—"}</span>
        </div>
        {isLoadingEvents && <p className="mt-5 text-sm">正在读取链上 ReceiptIssued 事件…</p>}
        {visibleEventError && (
          <p className="mt-5 text-sm text-error">事件读取失败：{getErrorMessage(visibleEventError)}</p>
        )}
        {!isLoadingEvents && !visibleEventError && validReceiptEvents?.length === 0 && (
          <p className="mt-5 text-sm text-base-content/70">暂无链上回执。</p>
        )}
        <div className="mt-5 flex flex-col gap-4">
          {validReceiptEvents?.map(event => {
            const { callId, amount, inputHash, timestamp } = event.args;
            if (callId === undefined || amount === undefined || !inputHash || timestamp === undefined) return null;

            return (
              <article
                key={`${event.transactionHash}-${event.logIndex}`}
                className="rounded-2xl border border-base-300 p-5"
              >
                <div className="grid gap-3 text-sm sm:grid-cols-2">
                  <p>
                    <span className="font-semibold">callId：</span>
                    {callId.toString()}
                  </p>
                  <p>
                    <span className="font-semibold">金额：</span>
                    {formatEther(amount)} MON
                  </p>
                  <p className="break-all sm:col-span-2">
                    <span className="font-semibold">tx hash：</span>
                    <span className="font-mono">{event.transactionHash}</span>
                  </p>
                  <p className="break-all sm:col-span-2">
                    <span className="font-semibold">输入哈希：</span>
                    <span className="font-mono">{inputHash}</span>
                  </p>
                  <p className="sm:col-span-2">
                    <span className="font-semibold">时间：</span>
                    {new Date(Number(timestamp) * 1000).toLocaleString("zh-CN")}
                  </p>
                </div>
              </article>
            );
          })}
        </div>
      </section>
    </main>
  );
};

export default Home;
