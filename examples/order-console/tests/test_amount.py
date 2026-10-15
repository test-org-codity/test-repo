import unittest

from app import format_amount


class AmountDisplayTests(unittest.TestCase):
    def test_single_item_price(self):
        self.assertEqual(format_amount(499), "$499.00")
