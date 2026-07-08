function classifyIssuePriority(issue) {
  const text = issue.title + ' ' + issue.description;
  const normalized = text.toLowerCase();

  if (normalized.includes('data loss') || normalized.includes('security')) {
    return 'P0';
  }

  if (normalized.includes('blocked') || normalized.includes('urgent')) {
    return 'P1';
  }

  if (normalized.includes('slow') || normalized.includes('confusing')) {
    return 'P2';
  }
}

const report = {
  title: 'Checkout is slow for some users',
  description: 'Several customers say the checkout page takes more than 10 seconds.'
};

console.log(classifyIssuePriority(report));
