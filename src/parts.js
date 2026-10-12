// The three parts of the software. Each is still a self-contained page in public/apps/
// and can be moved into React components one screen at a time.
export const PARTS = [
  {
    path: '/office',
    file: '/apps/office.html',
    name: 'Office software',
    who: 'Owner, manager, accountant',
    about: 'Chit groups, members, auctions, receipts, accounts and reports.',
  },
  {
    path: '/member',
    file: '/apps/member.html',
    name: 'Member app',
    who: 'Subscribers',
    about: 'Dues, receipts, auctions, prize money and account statement.',
  },
  {
    path: '/agent',
    file: '/apps/agent.html',
    name: 'Collection agent app',
    who: 'Field agents',
    about: "Today's route, collecting payments, receipts and day close.",
  },
]
