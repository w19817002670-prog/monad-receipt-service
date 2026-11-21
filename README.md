# MON 按次付费链上回执服务

基于 [scaffold-monad-foundry](https://github.com/monad-developers/scaffold-monad-foundry) 和 [Scaffold-ETH 2](https://scaffoldeth.io) 构建的 Monad Testnet 示例应用。脚手架及其中通用组件归原项目及其贡献者所有，并非本项目原创；本说明仅补充本项目的合约服务、演示与运行方式。

## 项目概述

用户支付固定数量的 MON 调用链上服务，合约保存回执并发出 `ReceiptIssued` 事件，前端展示本次交易状态和历史回执。

核心功能：

- 每次支付 `0.1 MON` 调用 `callService`，输入为 1–256 字节的 UTF-8 文本。
- 链上保存 `callId`、调用者、输入哈希、区块高度和时间戳。
- 支付确认后直接解析本次交易回执中的 `ReceiptIssued`。
- 保留历史回执查询、交易失败提示、防连点、竞态与切网保护。
- 支付金额不足时由合约拒绝，不生成成功回执。

## 技术栈

- Next.js 15.5.28、React 19、TypeScript
- RainbowKit、Wagmi、Viem
- Foundry、Solidity
- Yarn 3.2.3（通过 Corepack 使用）

## 环境要求

- [Node.js](https://nodejs.org/) >= 20.18.3
- [Foundry](https://book.getfoundry.sh/getting-started/installation)，需提供 `forge`
- Git 与 Corepack

## 安装与运行

在仓库根目录安装依赖：

```bash
corepack yarn install
```

启动前端开发服务器：

```bash
cd packages/nextjs && corepack yarn dev
```

运行合约测试：

```bash
cd packages/foundry && forge test
```

## Monad Testnet 与合约

- 网络：Monad Testnet
- Chain ID：`10143`
- `MonReceiptService` 合约：`0xE9F0426A69B0F5c3F7cAFF7E784d04277419C441`
- 部署区块：`81521306`

## 演示流程

1. 输入有效文本并支付 `0.1 MON`，交易成功后生成 `callId = 1` 的回执。
2. 再次正常支付 `0.1 MON`，生成 `callId = 2` 的回执。
3. 使用“演示少付”按钮尝试支付 `0.05 MON`，合约以 `IncorrectPayment` 拒绝调用；该次操作不得显示为支付成功，也不会生成正常回执。

## 原脚手架说明

Scaffold-ETH 2 是用于构建以太坊去中心化应用的开源工具包，提供合约热更新、Wagmi/Viem 自定义 hooks、常用 Web3 组件、钱包集成及本地开发能力。其文档与贡献指南仍适用于脚手架通用部分：

- [Scaffold-ETH 文档](https://docs.scaffoldeth.io)
- [Scaffold-ETH 网站](https://scaffoldeth.io)
- [Scaffold-ETH 贡献指南](https://github.com/scaffold-eth/scaffold-eth-2/blob/main/CONTRIBUTING.md)

脚手架原始代码及本仓库相关代码的许可证见 [LICENCE](LICENCE)。
