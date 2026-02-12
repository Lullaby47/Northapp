#!/usr/bin/env python3
"""
Test suite for amount picker logic
Run with: py -3 parser/tests/test_amount_picker.py (Windows) or python3 parser/tests/test_amount_picker.py (Linux/Mac)
"""
import sys
import os

# Add parent directory to path to import parser
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from parse_email import pick_transaction_amount

def test_chime_style_email():
    """Test Chime-style email with transaction amount and note amount"""
    email_content = """
    You just received $10.00 from John Doe.
    
    Transaction details:
    Amount: $10.00
    Date: 2024-01-15
    
    Note: $50
    This is a user note with a different amount.
    """
    email_subject = "Payment received"
    
    amount, debug = pick_transaction_amount(email_content, email_subject)
    
    assert amount == "10.0", f"Expected '10.0', got '{amount}'"
    assert debug['chosen_amount'] == 10.0, f"Expected 10.0, got {debug['chosen_amount']}"
    assert debug['matched_keyword'] is not None, "Should have matched a transaction keyword"
    print("✅ Test 1 passed: Chime-style email picks $10.00, not $50")

def test_two_amounts_one_keyword():
    """Test email with two amounts but only one near transaction keywords"""
    email_content = """
    Payment received: $25.00
    
    Your balance is now $1,234.56
    """
    email_subject = "Payment notification"
    
    amount, debug = pick_transaction_amount(email_content, email_subject)
    
    assert amount == "25.0", f"Expected '25.0', got '{amount}'"
    assert debug['chosen_amount'] == 25.0, f"Expected 25.0, got {debug['chosen_amount']}"
    print("✅ Test 2 passed: Picks amount near transaction keyword")

def test_example_amount_rejected():
    """Test email with only 'example' amount should return empty"""
    email_content = """
    For example, if you send $20, you will receive confirmation.
    """
    email_subject = "Payment instructions"
    
    amount, debug = pick_transaction_amount(email_content, email_subject)
    
    assert amount == "", f"Expected empty string, got '{amount}'"
    assert debug['chosen_amount'] is None, "Should not pick example amount"
    print("✅ Test 3 passed: Example amount correctly rejected")

def test_comma_amount():
    """Test email with comma-formatted amount"""
    email_content = """
    You just received $1,234.56 from payment.
    """
    email_subject = "Payment received"
    
    amount, debug = pick_transaction_amount(email_content, email_subject)
    
    assert amount == "1234.56", f"Expected '1234.56', got '{amount}'"
    assert debug['chosen_amount'] == 1234.56, f"Expected 1234.56, got {debug['chosen_amount']}"
    print("✅ Test 4 passed: Comma-formatted amount parsed correctly")

def test_note_rejection():
    """Test that amounts in notes are rejected"""
    email_content = """
    Payment received: $15.00
    
    Note from sender: $100
    This is just a note amount, not the transaction.
    """
    email_subject = "Payment received"
    
    amount, debug = pick_transaction_amount(email_content, email_subject)
    
    assert amount == "15.0", f"Expected '15.0', got '{amount}'"
    assert debug['chosen_amount'] == 15.0, f"Expected 15.0, got {debug['chosen_amount']}"
    print("✅ Test 5 passed: Note amount correctly ignored")

def test_no_transaction_keywords():
    """Test email with amounts but no transaction keywords"""
    email_content = """
    Your account balance is $500.00
    Minimum balance required: $10.00
    """
    email_subject = "Account information"
    
    amount, debug = pick_transaction_amount(email_content, email_subject)
    
    assert amount == "", f"Expected empty string (no transaction keywords), got '{amount}'"
    print("✅ Test 6 passed: No transaction keywords = empty amount")

def run_tests():
    """Run all tests"""
    print("Running amount picker tests...\n")
    
    tests = [
        test_chime_style_email,
        test_two_amounts_one_keyword,
        test_example_amount_rejected,
        test_comma_amount,
        test_note_rejection,
        test_no_transaction_keywords,
    ]
    
    passed = 0
    failed = 0
    
    for test in tests:
        try:
            test()
            passed += 1
        except AssertionError as e:
            print(f"❌ {test.__name__} failed: {e}")
            failed += 1
        except Exception as e:
            print(f"❌ {test.__name__} error: {e}")
            failed += 1
    
    print(f"\n{'='*50}")
    print(f"Tests passed: {passed}/{len(tests)}")
    print(f"Tests failed: {failed}/{len(tests)}")
    
    if failed > 0:
        sys.exit(1)
    else:
        print("✅ All tests passed!")
        sys.exit(0)

if __name__ == "__main__":
    run_tests()

