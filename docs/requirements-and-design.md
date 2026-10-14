# Chit Fund Management System: Requirements and Design

Oct 7, 2026 · @Srinivas Ramaiah

## Purpose and scope

This system replaces paper registers and spreadsheets in one chit fund company, from enrolling a subscriber to paying the prize and reporting to the registrar. The first release covers the daily core of the business and leaves the heavy back-office modules for later.

**In the first release**

- Chit groups with all registration, commission, penalty, auction and FDR/DD details
- Member registration, guarantors and agents
- Enrollment of subscribers into tickets, including several tickets per person and company-held tickets
- Auctions by bidding, bid offer, proxy, lottery or company decision, with dividend and prize calculation
- Receipts with installment selection, penalty, fees, cheque details, printing and SMS
- Prize (bid) payments to winners
- Outstanding, defaulter, collection and auction reports
- Logins with roles, an audit trail and automatic backups

**Later releases**

- Full accounts (day book, trial balance, balance sheet, cost centres)
- Suit file and court tracking
- Registrar forms and statutory returns
- Multiple branches with consolidation
- A mobile collection app for agents and payment-gateway collection

A working prototype of the first-release screens already exists and has been used to settle the layouts and the calculation rules below. It stores data in one browser only, so it is not the system of record.

## Users and roles

Five roles cover the business. Each login gets one role, and the owner can change what a role may do.

| Role | Who | Can do | Cannot do |
| --- | --- | --- | --- |
| Owner | Company owner or director | Everything, including users, settings, deletions and backups | Nothing is blocked |
| Manager | Branch or office manager | Groups, enrollment, auctions, receipts, payments, all reports | Users, backups, deleting records |
| Accountant | Accounts staff | Receipts, prize payments, outstanding and collection reports, cancel receipts | Create groups, record auctions |
| Collection agent | Field collector | Record receipts for assigned tickets, see own collection list and balances | See other agents' tickets, reports, auctions |
| Viewer | Auditor or partner | Read all screens and reports | Add, change or delete anything |

Every add, change, cancel and delete is stamped with the user and time in the audit log.

## Modules and features

The modules follow the menu of the reference software you shared, rebuilt with our own layouts. Fields marked required stop the save until filled.

| Module | Main fields and actions |
| --- | --- |
| Chit group | Branch, chit amount, name, installments (= tickets), auction type (monthly, fortnightly, weekly, daily), series, PSO number and date, bye-law number and date, commencement and termination dates, enrolment fee, registration place |
| Group rules | Company ticket numbers, no-auction installments, commission %, maximum bid ceiling %, GST % on commission, late fee % per annum for PS and NPS, dividend same or next month, prized subscribers pay full or reduced, round dividend down |
| Auction setup | Auction method (bidding and lottery, bidding only, lottery only, company decides), lottery discount %, auction day, time from and to, installment amount |
| FDR / DD | Number, date, period, simple or compound, amount, rate, maturity amount and date, bank and branch |
| Members | Title, name, relation, gender, DOB, occupation, PAN, Aadhaar last 4 digits, GST number, bank, photo, signature, roles; residential, office and correspondence addresses; employment and salary details |
| Enrollment | Group, ticket, subscriber, business agent, collection agent, zone, director, area, payment mode, pass book, chit agreement, intimation card, guarantors, nominee with address, introducer incentive |
| Auctions | Auction number, date, due date, next auction date, winning ticket, how decided, bid, GST, minutes filing date; shows bid payable, commission, net prize, dividend and net payable per ticket |
| Receipts | Date, mode, group and ticket, TR book number, collection agent, amount, penalty, enrolment fee, bank and other charges, installments chosen from a table, cheque or DD details, reason, print, SMS, cancel |
| Prize payments | Date, mode, amount and reference against each auction, with balance still payable |
| Agents | Agent registration, commission setup, commission bills and payments, TDS |
| Reports | Listed in the Reports section |
| Messages | SMS for receipts, auction dates and dues, with an editable template |
| Security | Users, roles, permissions, audit log, backups |

## Business rules and calculations

All amounts are in rupees, stored as exact decimals, never floating point. These rules are already built into the prototype and must be confirmed against your books before go-live.

1. **Installment** = chit amount ÷ number of installments, unless a fixed installment amount is entered.
2. **Commission** = chit amount × commission %.
3. **Bid (bid loss)** must be at least the commission and at most the ceiling % of the chit amount. For a lottery or a company decision the bid is the larger of the commission and the lottery discount % of the chit amount.
4. **Bid payable** = chit amount − bid.
5. **GST** = commission × GST %. It is deducted from the winner's prize, so **net prize** = bid payable − GST. It does not change the dividend or any installment.
6. **Dividend pool** = bid − commission. **Dividend per ticket** = pool ÷ number of tickets, rounded down when rounding is on. Company-held tickets share the dividend.
7. **Net payable per ticket** = installment − dividend. Prized subscribers (PS) pay the same figure, unless the group is set to full installment for PS.
8. **Dividend timing** is set per group: it applies to the same month's installment or from the next month.
9. **Late fee** = unpaid installment × annual rate × days late ÷ 365, counted from the installment's due date. PS and NPS have separate rates.
10. **Receipts** pay the installments the user chose first. Any excess goes to the oldest unpaid installments, then is held as advance. Penalty, enrolment fee and charges are recorded separately and do not reduce installments.
11. **A ticket wins once.** In a group with a company ticket, the first auction is always taken by the company ticket, decided by the company; this is locked on the screen and checked by the server. A company ticket may also win a no-auction month, and cannot win any other auction. Cancelled receipts stay in the records, marked cancelled, and are left out of totals.

**Worked example** (chit ₹5,00,000, 20 tickets, commission 5%, GST 18%, winning bid ₹1,00,000)

| Item | Amount (₹) |
| --- | --- |
| Installment | 25,000 |
| Commission | 25,000 |
| Bid payable to winner | 4,00,000 |
| GST on commission, deducted from prize | 4,500 |
| Net prize paid to winner | 3,95,500 |
| Dividend pool | 75,000 |
| Dividend per ticket | 3,750 |
| Net payable per ticket | 21,250 |
| Late fee, one installment of 21,250 unpaid for 30 days at 2% a year | 35 |

## Data model

&#91;embedded content: data model · 6 records\]

A person holds one or more tickets, each ticket (enrollment) belongs to one group and collects many receipts. A group runs one auction per period, and each auction can have prize payments. Members, agents and guarantors are all people with different roles.

## Screens and wireframes

Fourteen screens are wireframed on a separate page: [Chit Manager wireframes](https://claude.ai/artifact/DhYDY25YM7igoY2L6YW56o). Each shows the layout, and the notes under it state the behaviour that matters.

| Screen | Purpose | Release |
| --- | --- | --- |
| 1. Sign in | Personal login, lock after repeated failures | 1 |
| 2. Dashboard | Totals, upcoming auctions, recent receipts | 1 |
| 3. Chit groups | List with progress and status | 1 |
| 4. Chit group form | Create and edit a group in five sections | 1 |
| 5. Group detail | Rules at a glance and the ticket table | 1 |
| 6. Member registration | Full personal, address, employment and bank details | 1 |
| 7. Enrollment | Place a person in a ticket with agents, documents, guarantors and nominee | 1 |
| 8. Auction entry | Record an auction with a live prize and dividend panel, pay the prize | 1 |
| 9. Receipt entry | Choose installments from a table, then save, print or SMS | 1 |
| 10. Receipt print page | Printable slip with amount in words | 1 |
| 11. SMS | Editable message and send | 1 |
| 12. Outstanding report | Filters, table, totals and export, the pattern for all reports | 1 |
| 13. Users and roles | Users, role permissions, audit log, backups | 1 |
| 14. Agent mobile collection | Phone layout for field collection, works offline | 2 |

## Reports

The reference software has more than 400 reports. The first release carries the ones used every day. Every report can be exported to Excel and PDF and printed.

| Report | Filters | Main columns | Release |
| --- | --- | --- | --- |
| Members register | Group, status (PS, NPS, company, vacant) | Ticket, subscriber, mobile, status, prized in auction, agents, enrolment date | 1 |
| Member account copy | Group, ticket | Installment, due date, amount, dividend, payable, paid, balance, status; receipts list; penalty summary | 1 |
| Collection register | Date range, group, mode, agent | Receipt no., date, group, ticket, subscriber, mode, amount, subscription, penalty, charges, agent | 1 |
| Outstanding and defaulters | Group, PS or NPS, agent, only dues | Subscriber, due so far, paid, arrears, penalty due, total payable, agent | 1 |
| Auction chart | Group | Auction no., date, winner, bid, bid payable, GST, net prize, commission, dividend, net per ticket | 1 |
| Prize payments | Group | Auction, winner, net prize, paid, balance | 1 |
| Dividend list and statement | Group, auction | Ticket, subscriber, dividend credited | 1 |
| PS and NPS lists | Group | Ticket, subscriber, installments paid and due | 1 |
| Agent commission and TDS | Agent, period | Business introduced, commission, TDS, paid | 2 |
| Daily collection summary and day book | Date | Cash, cheque and online totals by user | 2 |
| Notices and letters | Group, subscriber | Auction letters, reminders, final notice, legal notice | 2 |
| Registrar forms and statutory returns | Group, year | Formats prescribed by the state registrar | 3 |
| Balance sheet, trial balance, profit and loss | Period | Standard accounting layouts | 3 |

The exact registrar formats vary by state, so the form layouts need sample copies of the filed forms before they can be built.

## Security, backup, audit and compliance

The system holds subscribers' identity and money records, so these are requirements, not extras.

- **Logins:** each person has their own user name and password, stored only as a salted hash. Sessions expire after inactivity. Optional second step by one-time code for the owner and accountant.
- **Roles:** permissions are checked on the server for every request, not only hidden in the screen.
- **Personal data:** Aadhaar is stored as the last 4 digits only. Photos and signatures sit in private storage, not public links. All traffic uses HTTPS and the database is encrypted at rest.
- **Audit trail:** every create, edit, cancel and delete records who, when, and the old and new values. Receipts and auctions are cancelled or reversed, never silently erased.
- **Backups:** automatic daily database backup kept for at least 30 days in a second location, plus a monthly copy kept for a year. A restore test is done before go-live and every quarter.
- **Data export:** the owner can export all data to Excel at any time, so the company is never locked in.
- **Compliance:** group registration, commission limits, bid ceilings, record formats and returns must follow the Chit Funds Act, 1982 and the rules of the state where the company is registered. A chartered accountant or advocate should confirm the rules and the report formats before go-live.
- **Availability:** the target is working hours availability with recovery from a failure in under 4 hours.

## Technical approach and hosting

&#91;embedded content: architecture · 5 parts\]

Every person reaches the system through a web page that also works on a phone. All rules live on the server, so a changed screen can never change an amount.

- **Web app:** the screens in the wireframes, built to work on laptop, tablet and phone. Release 2 adds an offline-capable collection screen for agents.
- **Server and database:** a standard web server with a PostgreSQL database. Amounts are stored as exact decimals and the auction and dividend calculations are covered by automated tests using the worked example in this document.
- **Hosting:** a cloud server in an Indian region, with a domain name and HTTPS. Backups go to a second location.
- **SMS:** one provider chosen by the company, with its sender ID and message templates registered as Indian rules require.
- **Who runs it:** a developer or IT person sets up the server, the domain, the SMS account and the backups once, then handles updates. The instructions and a checklist are part of delivery.
- **Ownership:** the company owns the source code, the database and the domain, and can export everything to Excel at any time.

## Prototype status (version 84, 9 October 2026)

The single-file prototype now covers most of the screens in this document; the table below shows what is built and what waits for the hosted build.

| Area | Built in the prototype |
| --- | --- |
| Look and navigation | Chitcare-style layout: header with financial year, IST clock and company name, top menu, left menu per section, launcher lists with OPEN links, teal colour scheme, login page with first-time Admin setup |
| Masters | Chit groups (termination date and FD maturity worked out automatically, bye-law number, no-auction first months, dividend from next month), members, enrollment, agent commission setup, accounts, staff and roles, dropdown lists, data import, customer app logins issued by the company |
| Collections | Receipts with the payment-score meter, post dated cheques, daily collection, future receipts (with refunds), advance receipts, denomination entry, received and issued cheque management |
| Auctions | Auctions, live auction room, lottery draw with winner celebration, reauction, company-decided months, company-wide switches to turn lottery and online bidding on or off |
| Payments and changes | Bid payable, bid advance, member removal, payments to removal members, subscriber refund, member transfer |
| Dashboard | Calls to make (remark, call-back date, promise to pay, payment score), post dated cheques due and coming in 3 days, FD maturity reminder 15 days ahead |
| Reports | Thirteen reports in five left-menu sections, including payment score and agent commission earned |
| Sharing | WhatsApp and email message from receipts and account copies (opens the user's own apps) |
| Security | Sign-in rules, lock after wrong passwords, sign-in history, role permissions |

Not built yet, and planned for the hosted build: Django and PostgreSQL storage, real password protection, automatic SMS, WhatsApp and email with the PDF attached, multi-company login, the customer mobile app, and a promise-to-pay report.

## Delivery phases, testing and go-live checklist

&#91;embedded content: roadmap · 5 phases, 4 gates\]

The phases are not drawn to scale. Durations are set once the open questions are answered and the number of branches and users is known.

- [ ] Prototype figures match the owner's books for one real group
- [ ] Chartered accountant confirms commission, GST and dividend treatment
- [ ] Sample copies of the registrar forms collected
- [ ] Server, domain, HTTPS and SMS account set up
- [ ] Automated tests pass using the worked example in this document
- [ ] A backup is restored on a clean server and the data checked
- [ ] Existing data imported and counted against the old records
- [ ] Staff trained by role, and only the owner holds the owner login
- [ ] Old method kept in parallel for one full cycle after go-live

## Open questions

These need the owner's decision or a sample before the production build can be finished.

- [ ] Lottery months: what does the winner receive, what does the foreman keep, and does a dividend exist?
- [ ] Do prized subscribers pay the full installment or the installment less dividend?
- [ ] Does the dividend apply to the same month's installment or from the next month?
- [x] GST on commission: only deducted from the winner's prize, or also charged to prized subscribers each month? Decided 14 October 2026: deducted from the winner's prize only (net prize = bid payable - GST). Old auctions imported from Chitcare keep the tax actually deducted then (service tax, then GST, at the rate of the auction's date), worked out from the prize paid.
- [ ] Company tickets: does the company pay installments on them and receive their dividend?
- [ ] Which state is the company registered in, and can we get sample copies of the registrar forms filed today?
- [ ] Size: number of branches, users, running groups and subscribers, so hosting can be sized.
- [ ] Is there existing data in Excel or other software to bring in, and in what format?
- [ ] SMS: which provider, and is the company's sender ID and message template registered for bulk SMS in India?
- [ ] Should the collection agent mobile app be in release 1 or release 2?
- [ ] Who will host and maintain the system: an IT person, a freelancer or an agency?
