// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "forge-std/Script.sol";
import "../src/ComplianceRegistry.sol";

/**
 * forge script script/DeployComplianceRegistry.s.sol:DeployComplianceRegistry \
 *   --rpc-url $SEPOLIA_RPC_URL --private-key $PRIVATE_KEY --broadcast
 *
 * Env:
 *  SEPOLIA_ROUTER=0xb83E47C2bC239B31AB286EA3DD212D87f0c7D77d
 *  SEPOLIA_DON_ID=0x66756e2d657468657265756d2d7365706f6c69612d310000000000000000000000
 *  SUBSCRIPTION_ID (uint64, funded with LINK)
 *  JS_SOURCE_PATH=scripts/functions/verifyIdentity.js (default)
 */
contract DeployComplianceRegistry is Script {
    address constant SEPOLIA_ROUTER = 0xb83e47c2bC239B31ab286eA3DD212D87F0C7D77D;
    // "fun-ethereum-sepolia-1" as bytes32
    bytes32 constant SEPOLIA_DON_ID =
        0x66756e2d657468657265756d2d7365706f6c69612d3100000000000000000000;

    function run() external {
        address router = SEPOLIA_ROUTER;
        try vm.envAddress("SEPOLIA_ROUTER") returns (address r) {
            router = r;
        } catch {}
        bytes32 donId = SEPOLIA_DON_ID;
        uint64 subId = uint64(vm.envUint("SUBSCRIPTION_ID"));
        string memory jsPath = vm.envOr("JS_SOURCE_PATH", string("scripts/functions/verifyIdentity.js"));
        string memory js = vm.readFile(jsPath);

        vm.startBroadcast();
        ComplianceRegistry reg = new ComplianceRegistry(router, donId, subId, js);
        // Optional: wire DON-hosted secrets after `functions-toolkit secrets upload`
        // reg.setSecrets(slotId, version, true);
        vm.stopBroadcast();

        console.log("ComplianceRegistry deployed at:", address(reg));
        console.log("Router:", router);
        console.log("Subscription:", subId);
    }
}
