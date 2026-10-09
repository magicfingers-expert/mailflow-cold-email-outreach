class EmailValidator {
  // RFC 5322 compliant regex for robust email validation
  static EMAIL_REGEX = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$/;

  static cleanAndValidate(rawText, suppressionList = []) {
    if (!rawText || typeof rawText !== 'string' || !rawText.trim()) {
      return {
        validRecipients: [],
        cappedRecipients: [],
        validCount: 0,
        duplicatesRemoved: 0,
        duplicateList: [],
        invalidCount: 0,
        invalidEmails: [],
        suppressedCount: 0,
        suppressedEmails: [],
        totalRaw: 0,
        isOverLimit: false,
        limitReached: false,
        canSend: false,
        error: null
      };
    }

    // Split by newlines, commas, semicolons, tabs
    const tokens = rawText
      .split(/[\r\n,;\t]+/)
      .map(t => t.trim())
      .filter(t => t.length > 0);

    const suppressionSet = new Set((suppressionList || []).map(s => s.toLowerCase().trim()));
    const seenSet = new Set();
    const validRecipients = [];
    const invalidEmails = [];
    const duplicateList = [];
    const suppressedEmails = [];

    for (let token of tokens) {
      // Strip angle brackets, quotes, mailto:, etc.
      let cleaned = token
        .replace(/<|>/g, '')
        .replace(/^mailto:/i, '')
        .replace(/^["']|["']$/g, '')
        .trim();

      if (!cleaned) continue;

      const normalized = cleaned.toLowerCase();

      // Check if invalid email format
      if (!this.EMAIL_REGEX.test(normalized)) {
        invalidEmails.push(token);
        continue;
      }

      // Check duplicates
      if (seenSet.has(normalized)) {
        duplicateList.push(normalized);
        continue;
      }

      seenSet.add(normalized);

      // Check suppression / unsubscribes
      if (suppressionSet.has(normalized)) {
        suppressedEmails.push(normalized);
        continue;
      }

      validRecipients.push(normalized);
    }

    const validCount = validRecipients.length;
    const isOverLimit = validCount > 50;
    const limitReached = validCount >= 50;
    const cappedRecipients = validRecipients.slice(0, 50);

    // Can only send if validCount > 0 AND invalidCount === 0 (user must fix invalid emails)
    const canSend = validCount > 0 && invalidEmails.length === 0;

    let error = null;
    if (invalidEmails.length > 0) {
      error = `Please fix or remove the ${invalidEmails.length} invalid email address${invalidEmails.length > 1 ? 'es' : ''} before sending.`;
    } else if (validCount === 0) {
      error = 'No valid email addresses provided.';
    }

    return {
      validRecipients,
      cappedRecipients,
      validCount,
      allowedCount: cappedRecipients.length,
      duplicatesRemoved: duplicateList.length,
      duplicateList,
      invalidCount: invalidEmails.length,
      invalidEmails,
      suppressedCount: suppressedEmails.length,
      suppressedEmails,
      totalRaw: tokens.length,
      isOverLimit,
      limitReached,
      canSend,
      error
    };
  }
}

module.exports = EmailValidator;
