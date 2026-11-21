// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "forge-std/Test.sol";
import "forge-std/Vm.sol";
import "../contracts/MonReceiptService.sol";

contract RejectingReceiver {
    receive() external payable {
        revert("Payment rejected");
    }

    fallback() external payable {
        revert("Payment rejected");
    }
}

contract MonReceiptServiceTest is Test {
    MonReceiptService public service;
    address public serviceProvider;
    address public caller;

    function setUp() public {
        serviceProvider = makeAddr("serviceProvider");
        caller = makeAddr("caller");
        service = new MonReceiptService(serviceProvider);
        vm.deal(caller, 10 ether);
    }

    function testZeroAddressServiceProviderRevertsDeployment() public {
        vm.expectRevert("Service provider cannot be zero address");
        new MonReceiptService(address(0));
    }

    function testCorrectPaymentStoresReceiptAndEmitsMatchingEvent() public {
        vm.roll(12_345);
        vm.warp(1_700_000_000);
        bytes32 expectedHash = keccak256(bytes("hello"));

        vm.recordLogs();
        _call(service, caller, "hello", service.PRICE());

        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(logs.length, 1);
        assertEq(logs[0].topics.length, 3);
        assertEq(logs[0].topics[0], keccak256("ReceiptIssued(uint256,address,bytes32,uint256,uint256,uint256)"));
        assertEq(uint256(logs[0].topics[1]), 1);
        assertEq(address(uint160(uint256(logs[0].topics[2]))), caller);

        (bytes32 eventInputHash, uint256 eventBlockHeight, uint256 eventTimestamp, uint256 eventAmount) =
            abi.decode(logs[0].data, (bytes32, uint256, uint256, uint256));
        (uint256 callId, address receiptCaller, bytes32 inputHash, uint256 blockHeight, uint256 timestamp) =
            service.receipts(1);

        assertEq(service.lastCallId(), 1);
        assertEq(callId, 1);
        assertEq(receiptCaller, caller);
        assertEq(inputHash, expectedHash);
        assertEq(blockHeight, 12_345);
        assertEq(timestamp, 1_700_000_000);
        assertEq(eventInputHash, inputHash);
        assertEq(eventBlockHeight, blockHeight);
        assertEq(eventTimestamp, timestamp);
        assertEq(eventAmount, 0.1 ether);
    }

    function testIncorrectPaymentsRevertWithoutSideEffects() public {
        uint256[] memory values = new uint256[](5);
        values[0] = 0;
        values[1] = 0.05 ether;
        values[2] = 0.099 ether;
        values[3] = 0.1 ether + 1;
        values[4] = 0.2 ether;

        for (uint256 i = 0; i < values.length; i++) {
            _expectIncorrectPayment("hello", values[i]);
        }

        assertEq(service.lastCallId(), 0);
        assertEq(serviceProvider.balance, 0);
        assertEq(address(service).balance, 0);
    }

    function testEmptyInputIsRejectedWithoutSideEffects() public {
        _expectInvalidInput("");
        assertEq(serviceProvider.balance, 0);
        assertEq(address(service).balance, 0);
    }

    function testAsciiInputLengthBoundaries() public {
        _call(service, caller, "a", service.PRICE());
        _call(service, caller, _ascii(256), service.PRICE());
        assertEq(service.lastCallId(), 2);

        uint256 balanceBefore = serviceProvider.balance;
        _expectInvalidInput(_ascii(257));
        assertEq(service.lastCallId(), 2);
        assertEq(serviceProvider.balance, balanceBefore);
    }

    function testUtf8InputUsesByteLength() public {
        string memory exactLimit = _repeat(unicode"🙂", 64);
        string memory overLimit = string.concat(exactLimit, "a");
        assertEq(bytes(exactLimit).length, 256);
        assertEq(bytes(overLimit).length, 257);

        _call(service, caller, exactLimit, service.PRICE());
        (,, bytes32 inputHash,,) = service.receipts(1);
        assertEq(inputHash, keccak256(bytes(exactLimit)));

        uint256 balanceBefore = serviceProvider.balance;
        _expectInvalidInput(overLimit);
        assertEq(service.lastCallId(), 1);
        assertEq(serviceProvider.balance, balanceBefore);
    }

    function testCallIdsAreGlobalSequentialAndFailuresDoNotConsumeIds() public {
        address otherCaller = makeAddr("otherCaller");
        vm.deal(otherCaller, 1 ether);

        _call(service, caller, "one", service.PRICE());
        _expectIncorrectPayment("failed payment", 0.05 ether);
        _call(service, otherCaller, "two", service.PRICE());
        _expectInvalidInput("");
        _call(service, caller, "three", service.PRICE());

        assertEq(service.lastCallId(), 3);
        (, address firstCaller,,,) = service.receipts(1);
        (, address secondCaller,,,) = service.receipts(2);
        (, address thirdCaller,,,) = service.receipts(3);
        assertEq(firstCaller, caller);
        assertEq(secondCaller, otherCaller);
        assertEq(thirdCaller, caller);
    }

    function testServiceProviderReceivesExactlyOnePricePerCall() public {
        uint256 initialBalance = serviceProvider.balance;

        _call(service, caller, "first", service.PRICE());
        assertEq(serviceProvider.balance - initialBalance, 0.1 ether);
        assertEq(address(service).balance, 0);

        uint256 balanceBeforeSecondCall = serviceProvider.balance;
        _call(service, caller, "second", service.PRICE());
        assertEq(serviceProvider.balance - balanceBeforeSecondCall, 0.1 ether);
        assertEq(serviceProvider.balance - initialBalance, 0.2 ether);
        assertEq(address(service).balance, 0);
    }

    function testRejectedTransferRevertsAllStateEventsAndFunds() public {
        RejectingReceiver rejectingReceiver = new RejectingReceiver();
        MonReceiptService rejectingService = new MonReceiptService(address(rejectingReceiver));

        uint256 price = rejectingService.PRICE();
        uint256 callerBalanceBefore = caller.balance;
        vm.recordLogs();
        vm.expectRevert(MonReceiptService.TransferFailed.selector);
        _call(rejectingService, caller, "hello", price);

        Vm.Log[] memory logs = vm.getRecordedLogs();
        // Foundry discards logs from reverted calls, so this alone cannot prove event atomicity.
        assertEq(logs.length, 0);
        assertEq(caller.balance, callerBalanceBefore);
        assertEq(rejectingService.lastCallId(), 0);
        _assertEmptyReceipt(rejectingService, 1);
        assertEq(address(rejectingReceiver).balance, 0);
        assertEq(address(rejectingService).balance, 0);
    }

    function testPriceAndServiceProviderRemainUnchanged() public {
        assertEq(service.PRICE(), 0.1 ether);
        assertEq(service.serviceProvider(), serviceProvider);

        _call(service, caller, "first", service.PRICE());
        _call(service, caller, "second", service.PRICE());

        assertEq(service.PRICE(), 0.1 ether);
        assertEq(service.serviceProvider(), serviceProvider);
    }

    function testAbiExposesOnlySpecifiedFunctions() public view {
        string memory artifact =
            vm.readFile(string.concat(vm.projectRoot(), "/out/MonReceiptService.sol/MonReceiptService.json"));
        uint256 functionCount;

        for (uint256 i = 0; i < 32; i++) {
            string memory entryPath = string.concat(".abi[", vm.toString(i), "]");
            try vm.parseJson(artifact, string.concat(entryPath, ".type")) returns (bytes memory encodedType) {
                if (encodedType.length == 0) {
                    break;
                }
                string memory entryType = abi.decode(encodedType, (string));
                if (keccak256(bytes(entryType)) == keccak256("function")) {
                    string memory name = abi.decode(vm.parseJson(artifact, string.concat(entryPath, ".name")), (string));
                    assertTrue(_isAllowedFunction(name), name);
                    functionCount++;
                }
            } catch {
                break;
            }
        }

        assertEq(functionCount, 5);
    }

    function _call(MonReceiptService target, address from, string memory text, uint256 value) internal {
        vm.prank(from);
        target.callService{ value: value }(text);
    }

    function _expectIncorrectPayment(string memory text, uint256 value) internal {
        uint256 callIdBefore = service.lastCallId();
        uint256 price = service.PRICE();
        vm.recordLogs();
        vm.expectRevert(abi.encodeWithSelector(MonReceiptService.IncorrectPayment.selector, price, value));
        _call(service, caller, text, value);
        assertEq(vm.getRecordedLogs().length, 0);
        assertEq(service.lastCallId(), callIdBefore);
        _assertEmptyReceipt(service, callIdBefore + 1);
    }

    function _expectInvalidInput(string memory text) internal {
        uint256 callIdBefore = service.lastCallId();
        uint256 price = service.PRICE();
        vm.recordLogs();
        vm.expectRevert(abi.encodeWithSelector(MonReceiptService.InvalidInputLength.selector, bytes(text).length));
        _call(service, caller, text, price);
        assertEq(vm.getRecordedLogs().length, 0);
        assertEq(service.lastCallId(), callIdBefore);
        _assertEmptyReceipt(service, callIdBefore + 1);
    }

    function _assertEmptyReceipt(MonReceiptService target, uint256 callId) internal view {
        (uint256 storedCallId, address receiptCaller, bytes32 inputHash, uint256 blockHeight, uint256 timestamp) =
            target.receipts(callId);
        assertEq(storedCallId, 0);
        assertEq(receiptCaller, address(0));
        assertEq(inputHash, bytes32(0));
        assertEq(blockHeight, 0);
        assertEq(timestamp, 0);
    }

    function _ascii(uint256 length) internal pure returns (string memory) {
        bytes memory value = new bytes(length);
        for (uint256 i = 0; i < length; i++) {
            value[i] = bytes1(uint8(97));
        }
        return string(value);
    }

    function _repeat(string memory unit, uint256 count) internal pure returns (string memory) {
        bytes memory value;
        for (uint256 i = 0; i < count; i++) {
            value = bytes.concat(value, bytes(unit));
        }
        return string(value);
    }

    function _isAllowedFunction(string memory name) internal pure returns (bool) {
        bytes32 nameHash = keccak256(bytes(name));
        return nameHash == keccak256("PRICE") || nameHash == keccak256("callService")
            || nameHash == keccak256("lastCallId") || nameHash == keccak256("receipts")
            || nameHash == keccak256("serviceProvider");
    }
}
