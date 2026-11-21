// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "./DeployHelpers.s.sol";
import "../contracts/MonReceiptService.sol";

contract DeployMonReceiptService is ScaffoldETHDeploy {
    address private constant SERVICE_PROVIDER = 0x8387ab25E860ce073C5f1EcCBF3f4F219F80b565;

    function run() external ScaffoldEthDeployerRunner {
        MonReceiptService service = new MonReceiptService(SERVICE_PROVIDER);
        deployments.push(Deployment("MonReceiptService", address(service)));
    }
}
