// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";

// Bridge kontratının kullanacağı interface
interface IOXOBTC {
    function mint(address to, uint256 amount) external;
    function burnFrom(address from, uint256 amount) external;
}

contract OXOBTC is ERC20, AccessControl, IOXOBTC {
    bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE");

    event Minted(address indexed to, uint256 amount, address indexed minter);
    event Burned(address indexed from, uint256 amount, address indexed burner);

    constructor(string memory name, string memory symbol)
        ERC20(name, symbol)
    {
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(MINTER_ROLE, msg.sender);
    }

    function decimals() public pure override returns (uint8) {
        return 8;
    }

    function supportsInterface(bytes4 interfaceId)
        public
        view
        override(AccessControl)
        returns (bool)
    {
        return super.supportsInterface(interfaceId);
    }

    // ✅ Sadece IOXOBTC override ediliyor
    function mint(address to, uint256 amount)
        external
        override(IOXOBTC)
        onlyRole(MINTER_ROLE)
    {
        _mint(to, amount);
        emit Minted(to, amount, msg.sender);
    }

    // ✅ Sadece IOXOBTC override ediliyor
    function burnFrom(address from, uint256 amount)
        external
        override(IOXOBTC)
    {
        _spendAllowance(from, msg.sender, amount);
        _burn(from, amount);
        emit Burned(from, amount, msg.sender);
    }

    function isMinter(address account) external view returns (bool) {
        return hasRole(MINTER_ROLE, account);
    }
}
