# Chit Master Pro: Hosted Version Plan

Oct 11, 2026 · @Srinivas Ramaiah

The hosted version moves your data from one browser to a secure online database with real logins, daily backups, and automatic messages and payments. Your importer, reports and screens carry over, so the testing you have done is not lost.

## What changes

The screens and rules stay the same. What changes is where the data lives and who can reach it.

| Area | Today (prototype) | Hosted version |
| --- | --- | --- |
| Where data is stored | One browser on one computer | A secure online database in an Indian data centre |
| Backups | Manual download | Automatic daily backup, kept for 30 days |
| Logins | Shared, inside the page | Each person has their own login and role (owner, accountant, branch staff, agent, customer) |
| Users at the same time | One | Many, across branches |
| Customer and agent apps | Demo screens with sample data | Connected to the live data |
| SMS and WhatsApp | You send them yourself | Sent automatically (due reminders, receipts, auction results) |
| Online payment | Not available | Customers pay by UPI or card through Razorpay and the receipt is made automatically |
| CIBIL | Score shown inside the software | Reported to the credit bureau on the required schedule |
| Audit trail | Latest 3,000 actions | Every action, kept permanently |

## How it will be built

Four parts, each with one job.

1. **Database (PostgreSQL).** Holds every member, group, receipt, voucher and account. Your current screens and calculations are rebuilt on top of it, rule for rule.
2. **Web software (Django).** The office software your staff open in a browser. It checks each login and what that person may see or change.
3. **Mobile apps.** The customer app and the collection agent app, using the same database so a receipt entered by an agent shows in the office at once.
4. **Message and payment links.** SMS and WhatsApp through a registered provider, and online payments through Razorpay.

Someone must hold the hosting account and deploy the software. I can write the code and the import tools, but a developer or IT vendor you trust should own the server and the backups, so the company is never dependent on one person.

## Build stages

The core comes first, because everything else depends on it. Sizes are my rough estimates, not quotes. The waiting time on registrations (DLT, Razorpay, credit bureau) is outside my control, so those applications should start early.

| Stage | What it delivers | Waits on | Size |
| --- | --- | --- | --- |
| 1. Core system | Database, logins and roles, groups, members, auctions, receipts, accounts, reports | Hosting account, developer to deploy | Large |
| 2. Data import | The importer you tested, moved to the hosted system, with daily backups | Stage 1 | Medium |
| 3. Customer and agent apps | Live apps with their own logins | Stage 1 | Large |
| 4. SMS and WhatsApp | Due reminders, receipts, auction results | DLT registration, WhatsApp business approval | Medium |
| 5. Online payments | UPI and card collection, automatic receipts | Razorpay account approval | Medium |
| 6. Credit bureau reporting | Monthly member data to the bureau | Bureau membership and format | Medium |
| 7. Parallel run and switch | One month side by side with the old software, then the switch | Stages 1 to 3 | Your time |

## What I need from you

These decisions and applications can start now, before any building.

- [ ] Who will own the hosting account and deploy the software (your own IT person or a vendor)
- [ ] Your accountant's answer on Loan on Chits and the opening balances
- [ ] The list of users and roles: owner, accountant, branch staff, agents
- [ ] How many branches will use it, and whether each sees only its own data
- [ ] Start the DLT registration for SMS (sender name and message templates)
- [ ] Start the WhatsApp business account approval
- [ ] Apply for a Razorpay business account
- [ ] Find out the credit bureau membership, report format and monthly deadline you must follow
- [ ] The complete member list export from the old software, with each person's member code
- [ ] A decision on how long to keep old data and audit records

## Switch-over plan

The old software stays the master until the new one has matched it for a full month.

1. Import the complete member list from the old software, then the groups, auctions and receipts, group by group.
2. Check each group: the totals of subscription due, paid and balance must match the old software ticket by ticket.
3. Load the opening balances from the audited trial balance, with your accountant present.
4. Run both systems in parallel for one month. Enter every day's work in both.
5. Each day, compare the day book, cash book and collection total. Fix any difference the same day.
6. Compare the month-end trial balance with the old software.
7. When a full month matches, move over. Keep the old software read-only for at least one financial year.

## Running costs and risks

I have not priced any of these. Prices change, so ask each provider for a current quote before you decide.

| Running cost | How it is charged |
| --- | --- |
| Hosting and database | Monthly fee from the hosting provider, growing with the data |
| SMS and WhatsApp | A fee per message sent |
| Razorpay | A percentage of each online payment |
| Developer or IT support | Monthly retainer or per request |

The main risks and how to handle them:

- **Rules that differ from the old software.** Dividend, late fee and cheque return rules were matched on JP-14 only. Check every group type in the parallel run.
- **Customer data.** Mobile numbers and PAN need access limited by role and a clear policy on who can export them.
- **One person holds the keys.** Keep the hosting and database passwords with the company, not with one individual.
- **Registrations take time.** DLT, WhatsApp and the credit bureau are the slowest steps, so start them first.

## Changes after going live

Changes to the software go through a test copy and a numbered release, never straight into the live system.

- **Settings and data** (account heads, group rules, users, SMS templates): staff change these in the software. They appear in the audit trail and need no developer.
- **Software changes** (a new report, a changed calculation, a new screen): written and tried on a test copy first, then released at night or on a Sunday.
- **Backup before every release.** A full backup is taken automatically, so the data can be restored if a release goes wrong.
- **Rollback.** The previous version can be put back, usually in minutes.
- **Changes to stored data** (for example a new field on every member): applied as a scripted migration, tried on a copy of your real data first. Existing receipts and accounts are not rewritten.
- **One approver.** One named person approves every release. Your accountant checks any change that touches accounts, GST or TDS.
- **Release notes.** Each release has a version number and a note of what changed, so you always know what is running.

Who makes the changes: the code is kept in a repository owned by the company. Claude or any developer can write a change there. A change is released only after it has been tested and approved. Nobody edits the live server directly.

## Selling to other chit companies

The software can be offered to other chit companies once the hosted version is built, but the choice to do so must be made before the build starts, because it changes the design. This section is not legal advice; have a lawyer check the legal points. Decision on 11 October 2026: the hosted version will be built ready for several companies (separate data per company, per-company settings), so selling later stays possible. Your own company runs as the first one.

**Design choices to make early**

| Choice | Why it matters |
| --- | --- |
| One system for many companies, with each company's data kept completely apart | Much cheaper to run and update than a separate copy per company, but it must be planned from the start |
| Settings per company: name, logo, bye-laws, account heads, SMS templates | Each company runs under its own identity |
| State-wise statutory reports and forms | Rules and registrar formats differ between states |
| Company-level roles and a platform admin | Your staff can help a customer without seeing other companies' data |
| Billing records per company | Needed to charge by company, member or active chit |

**Ways to charge**

- A monthly or yearly fee per company
- A fee by number of active chits or members
- A one-time setup and data import charge
- A separate charge for SMS, WhatsApp and online payments, passed on at cost plus a margin

**Legal and business checklist**

- [ ] A lawyer confirms who owns the code and your right to resell it
- [ ] A lawyer reviews how close the screens and reports are to the old software (Chitcare) and which parts must be redesigned. Statutory formats such as Form VII are required by law and are fine. Claude redesigns the screens and reports that mirror the old software (account copy beyond the statutory columns, trial balance, balance sheet and profit and loss layouts, menu names, wording) before any sale, after your go-live comparison is finished.
- [ ] A service agreement for each customer: price, support hours, data ownership, confidentiality, and what happens if they leave
- [ ] A privacy policy and data handling under India's data protection law (DPDP Act)
- [ ] A security review before another company's data is stored
- [ ] A support plan: who answers calls, response times, training
- [ ] Confidentiality terms, since competitors in the same city may share a platform
- [ ] Terms for each state's rules before a company from that state is signed up

## Online payment charges

The company charges an internet handling charge of 2% on every online payment, whatever the payment mode. It is the company's own charge, not a pass-through of the gateway fee.

**How it works in the software**

- The rate is a setting (2% to start). It can be changed later, and it can be set to 0 for a payment mode if needed.
- The customer sees the charge before paying: installment, handling charge, and total.
- The subscription is credited in full. The charge is shown as its own line on the receipt and in the Charges column of the account copy.
- In Accounts, the charge is company income (Internet handling charges). The fee Razorpay deducts is an expense, so the difference is the company's gain or loss.
- Every online receipt records the gateway payment reference, so refunds and disputes can be traced.

**To confirm before this stage is built**

- [ ] Decided 12 October 2026: the charge is allowed. Keep the chit agreement or bye-laws wording that permits it on file.
- [ ] Decided 12 October 2026: it is charged as an internet handling charge on every mode, UPI included, and is not named as a payment gateway charge
- [ ] Decided 12 October 2026: GST applies to the handling charge and the company bears it. The customer pays exactly 2% of the final bill; the GST is taken out of that 2%. Still to confirm with the accountant: the GST rate and how the GST is shown on the receipt or invoice
- [ ] Decided 12 October 2026: the 2% is worked out on the final bill, meaning the installment plus penalty and any other charges due in that payment
- [ ] The wording shown to the customer and printed on the receipt
