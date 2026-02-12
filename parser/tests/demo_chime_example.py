#!/usr/bin/env python3
"""
Demo: Show parser output for Chime-style email
Run with: py -3 parser/tests/demo_chime_example.py
"""
import sys
import os
import json

# Add parent directory to path
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from parse_email import parse_email

# Chime-style email example (sanitized)
chime_email_content = """
From: noreply@chime.com
Subject: You just received $10.00

Hello,

You just received $10.00 from John Doe.

Transaction Details:
Amount: $10.00
Date: January 15, 2024
Reference: TXN-12345

Note from sender: $50
This is a user note with a different amount that should be ignored.

Your balance is now $1,234.56

Thank you for using Chime.
"""

chime_email_subject = "You just received $10.00"

print("=" * 60)
print("Chime Email Example")
print("=" * 60)
print("\nEmail Content (sanitized):")
print(chime_email_content)
print("\n" + "=" * 60)
print("Parser Output:")
print("=" * 60)

result = parse_email(chime_email_content, chime_email_subject)

print(json.dumps(result, indent=2, ensure_ascii=False))

print("\n" + "=" * 60)
print("Analysis:")
print("=" * 60)
print(f"✅ Parser amount: {result['amount']}")
print(f"✅ Expected: 10.0")
if result['amount'] == "10.0":
    print("✅ SUCCESS: Parser correctly picked $10.00, not $50 or $1,234.56")
else:
    print(f"❌ FAILED: Expected '10.0', got '{result['amount']}'")

if result.get('amount_debug'):
    debug_info = json.loads(result['amount_debug'])
    print(f"\nDebug Info:")
    print(f"  - Chosen amount: {debug_info.get('chosen_amount')}")
    print(f"  - Matched keyword: {debug_info.get('matched_keyword')}")
    print(f"  - Total candidates: {debug_info.get('total_candidates')}")
    print(f"  - Reason: {debug_info.get('reason')}")

