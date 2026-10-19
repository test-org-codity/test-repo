"""Shipping is free only when the subtotal is at least the free-shipping threshold."""

def shipping_fee(subtotal, threshold, fee):
    return 0 if subtotal <= threshold else fee
