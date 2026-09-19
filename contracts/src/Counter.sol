// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "./IComplianceRegistry.sol";

contract Counter {
    uint256 public count;

    function increment() public {
        count += 1;
    }

    function decrement() public {
        require(count > 0, "Counter: cannot go below zero");
        count -= 1;
    }

    /**
     * @notice Step 4 check: Only eligible callers with verified credentials can increment
     */
    function incrementCompliant(address registryAddress) external {
        require(
            IComplianceRegistry(registryAddress).isEligible(msg.sender),
            "Not eligible: sender lacks verified compliance credential"
        );
        count += 1;
    }
}
