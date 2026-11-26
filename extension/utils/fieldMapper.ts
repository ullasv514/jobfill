// ============================================================
// Field Mapper
// ============================================================
// Maps detected field types to actual profile values.
// Handles primary selection and compound fields.
// ============================================================

import type { UserProfile } from '../types/profile';
import { getPrimary } from '../types/profile';
import type { ProfileFieldKey, FieldMapping, DetectedField } from '../types/autofill';
import { pickEducation, resolveEducationValue } from './educationPicker';
import { countryToNationality } from './nationality';

function getExpectedPassOutYear(profile: UserProfile, field: DetectedField): string | undefined {
  const label = [
    field.attributes.labelText,
    field.attributes.ariaLabel,
    field.attributes.name,
    field.attributes.id,
  ].filter(Boolean).join(' ');
  const educationKeyMatch = field.profileField?.match(/^education\.(current|latest|highest|ug|pg|phd)\.endDate$/);
  if (!/\b(?:pass(?:ed)?\s*out|graduat(?:ion|ing)|completion)\b/i.test(label)
    || !/\b(?:year|date)\b/i.test(label)
    || !educationKeyMatch) {
    return undefined;
  }

  const education = pickEducation(profile, educationKeyMatch[1] as 'current' | 'latest' | 'highest' | 'ug' | 'pg' | 'phd');
  if (!education) return undefined;

  // Prefer a year explicitly saved in the education end-date field.
  const explicitYear = education.endDate?.match(/\b(?:19|20)\d{2}\b/)?.[0];
  if (explicitYear) return explicitYear;

  // The profile only has a start year for this ongoing B.Tech/B.E. Use the
  // standard four-year duration to answer a pass-out-year question.
  const degree = education.degree.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  if (!/\b(?:b tech|b e|bachelor of technology|bachelor of engineering)\b/.test(degree)) return undefined;
  const startYear = education.startDate?.match(/\b(?:19|20)\d{2}\b/)?.[0];
  return startYear ? String(Number(startYear) + 4) : undefined;
}

/** Resolve the exact saved value, with a narrow expected-year fallback for pass-out labels. */
export function resolveProfileValueForField(
  profile: UserProfile,
  field: DetectedField,
  profileField: ProfileFieldKey | null = field.profileField,
): string | undefined {
  if (!profileField) return undefined;
  const contextualField = profileField === field.profileField ? field : { ...field, profileField };
  const expectedPassOutYear = getExpectedPassOutYear(profile, contextualField);
  if (expectedPassOutYear) return expectedPassOutYear;
  return resolveProfileValue(profile, profileField);
}

function parseExperienceDate(str?: string): Date | null {
  if (!str) return null;
  const trimmed = str.trim();
  if (/^\d{4}$/.test(trimmed)) {
    return new Date(Number(trimmed), 0, 1);
  }
  const ymMatch = trimmed.match(/^(\d{4})[-/.](\d{1,2})$/);
  if (ymMatch) {
    return new Date(Number(ymMatch[1]), Number(ymMatch[2]) - 1, 1);
  }
  const d = new Date(trimmed);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function calculateTotalExperience(profile: UserProfile): string {
  if (profile.professional?.yearsOfExperience?.trim()) {
    return profile.professional.yearsOfExperience.trim();
  }

  const validExperiences = (profile.experience || []).filter(
    (item) => item && (item.company?.trim() || item.title?.trim())
  );

  if (validExperiences.length === 0) {
    return 'Fresher';
  }

  let totalMonths = 0;
  let hasValidDuration = false;

  for (const exp of validExperiences) {
    if (!exp.startDate) continue;
    const start = parseExperienceDate(exp.startDate);
    if (!start) continue;

    const isCurrent = exp.current || !exp.endDate || /present|current|now/i.test(exp.endDate);
    const end = isCurrent ? new Date() : parseExperienceDate(exp.endDate);
    if (!end) continue;

    const months = (end.getFullYear() - start.getFullYear()) * 12 + (end.getMonth() - start.getMonth());
    if (months > 0) {
      totalMonths += months;
      hasValidDuration = true;
    }
  }

  if (hasValidDuration) {
    if (totalMonths < 12) {
      return totalMonths <= 0 ? 'Fresher' : `${totalMonths} month${totalMonths > 1 ? 's' : ''}`;
    }
    const years = +(totalMonths / 12).toFixed(1);
    return `${years} years`;
  }

  return `${validExperiences.length} year${validExperiences.length > 1 ? 's' : ''}`;
}

/**
 * Resolve a profile field key to its actual value from the profile.
 */
export function resolveProfileValue(
  profile: UserProfile,
  fieldKey: ProfileFieldKey,
): string | undefined {
  const educationValue = resolveEducationValue(profile, fieldKey);
  if (educationValue !== undefined) return educationValue;

  switch (fieldKey) {
    // ---- Personal ----
    case 'personal.firstName':
      return profile.personal.firstName || undefined;
    case 'personal.middleName':
      return profile.personal.middleName || undefined;
    case 'personal.lastName':
      return profile.personal.lastName || undefined;
    case 'personal.fullName': {
      const parts = [
        profile.personal.firstName,
        profile.personal.middleName,
        profile.personal.lastName,
      ].filter(Boolean);
      return parts.length > 0 ? parts.join(' ') : undefined;
    }
    case 'personal.dateOfBirth':
      return profile.personal.dateOfBirth || undefined;
    case 'personal.gender':
      return profile.personal.gender || undefined;
    case 'personal.nationality':
      return countryToNationality(getPrimary(profile.addresses)?.country);

    // ---- Contact ----
    case 'contact.primaryPhoneNumber':
    case 'phones.primary':
      return getPrimary(profile.phones)?.value;
    case 'contact.primaryEmailAddress':
    case 'emails.primary':
      return getPrimary(profile.emails)?.value;
    case 'contact.personalEmailAddress':
    case 'emails.personal':
      return profile.emails.find((email) => email.label === 'Personal')?.value || getPrimary(profile.emails)?.value;
    case 'contact.universityEmailAddress':
    case 'emails.university':
      return profile.emails.find((email) => email.label === 'University')?.value;

    // ---- Address - Single Lines ----
    case 'address.primary.streetAddressLine1':
    case 'addresses.primary.line1':
      return getPrimary(profile.addresses)?.line1;
    case 'address.primary.streetAddressLine2':
    case 'addresses.primary.line2':
      return getPrimary(profile.addresses)?.line2;
    case 'address.primary.city':
    case 'addresses.primary.city':
      return getPrimary(profile.addresses)?.city;
    case 'address.primary.state':
    case 'addresses.primary.state':
      return getPrimary(profile.addresses)?.state;
    case 'address.primary.postalCode':
    case 'addresses.primary.postalCode':
      return getPrimary(profile.addresses)?.postalCode;
    case 'address.primary.country':
    case 'addresses.primary.country':
      return getPrimary(profile.addresses)?.country;
    case 'address.primary.fullAddress':
    case 'addresses.primary.full': {
      const addr = getPrimary(profile.addresses);
      if (!addr) return undefined;
      return [addr.line1, addr.line2, addr.city, addr.state, addr.postalCode, addr.country]
        .filter(Boolean)
        .join(', ');
    }

    // ---- Address - Compounds ----
    case 'address.primary.streetAddressLine1AndLine2': {
      const addr = getPrimary(profile.addresses);
      const parts = [addr?.line1, addr?.line2].filter(Boolean);
      return parts.length > 0 ? parts.join(', ') : undefined;
    }
    case 'address.primary.streetAddressAndCity': {
      const addr = getPrimary(profile.addresses);
      const parts = [addr?.line1, addr?.city].filter(Boolean);
      return parts.length > 0 ? parts.join(', ') : undefined;
    }
    case 'address.primary.streetAddressCityAndState': {
      const addr = getPrimary(profile.addresses);
      const parts = [addr?.line1, addr?.city, addr?.state].filter(Boolean);
      return parts.length > 0 ? parts.join(', ') : undefined;
    }
    case 'address.primary.streetAddressCityStateAndPostalCode': {
      const addr = getPrimary(profile.addresses);
      const parts = [addr?.line1, addr?.city, addr?.state, addr?.postalCode].filter(Boolean);
      return parts.length > 0 ? parts.join(', ') : undefined;
    }
    case 'address.primary.cityAndState':
    case 'addresses.primary.cityState': {
      const addr = getPrimary(profile.addresses);
      const parts = [addr?.city, addr?.state].filter(Boolean);
      return parts.length > 0 ? parts.join(', ') : undefined;
    }
    case 'address.primary.cityAndPostalCode': {
      const addr = getPrimary(profile.addresses);
      const parts = [addr?.city, addr?.postalCode].filter(Boolean);
      return parts.length > 0 ? parts.join(' ') : undefined;
    }
    case 'address.primary.cityAndCountry': {
      const addr = getPrimary(profile.addresses);
      const parts = [addr?.city, addr?.country].filter(Boolean);
      return parts.length > 0 ? parts.join(', ') : undefined;
    }
    case 'address.primary.stateAndPostalCode': {
      const addr = getPrimary(profile.addresses);
      const parts = [addr?.state, addr?.postalCode].filter(Boolean);
      return parts.length > 0 ? parts.join(' ') : undefined;
    }
    case 'address.primary.stateAndCountry': {
      const addr = getPrimary(profile.addresses);
      const parts = [addr?.state, addr?.country].filter(Boolean);
      return parts.length > 0 ? parts.join(', ') : undefined;
    }
    case 'address.primary.postalCodeAndCountry': {
      const addr = getPrimary(profile.addresses);
      const parts = [addr?.postalCode, addr?.country].filter(Boolean);
      return parts.length > 0 ? parts.join(', ') : undefined;
    }
    case 'address.primary.cityStateAndPostalCode': {
      const addr = getPrimary(profile.addresses);
      const parts = [addr?.city, addr?.state, addr?.postalCode].filter(Boolean);
      return parts.length > 0 ? parts.join(', ') : undefined;
    }
    case 'address.primary.cityStateAndCountry': {
      const addr = getPrimary(profile.addresses);
      const parts = [addr?.city, addr?.state, addr?.country].filter(Boolean);
      return parts.length > 0 ? parts.join(', ') : undefined;
    }
    case 'address.primary.cityPostalCodeAndCountry': {
      const addr = getPrimary(profile.addresses);
      const parts = [addr?.city, addr?.postalCode, addr?.country].filter(Boolean);
      return parts.length > 0 ? parts.join(', ') : undefined;
    }
    case 'address.primary.statePostalCodeAndCountry': {
      const addr = getPrimary(profile.addresses);
      const parts = [addr?.state, addr?.postalCode, addr?.country].filter(Boolean);
      return parts.length > 0 ? parts.join(', ') : undefined;
    }
    case 'address.primary.cityStatePostalCodeAndCountry': {
      const addr = getPrimary(profile.addresses);
      const parts = [addr?.city, addr?.state, addr?.postalCode, addr?.country].filter(Boolean);
      return parts.length > 0 ? parts.join(', ') : undefined;
    }

    // ---- Education (ug / pg / phd / highest / current / latest) ----
    // Handled by resolveEducationValue() before this switch.

    // ---- Secondary Education (12th & 10th) ----
    case 'education.twelfth.institutionName':
      return profile.secondaryEducation?.twelfth?.institution;
    case 'education.twelfth.percentage':
      return profile.secondaryEducation?.twelfth?.percentage;
    case 'education.twelfth.passingYear':
      return profile.secondaryEducation?.twelfth?.year;
    case 'education.twelfth.board':
      return profile.secondaryEducation?.twelfth?.board;
    case 'education.twelfth.stream':
      return profile.secondaryEducation?.twelfth?.stream;

    case 'education.tenth.institutionName':
      return profile.secondaryEducation?.tenth?.institution;
    case 'education.tenth.percentage':
      return profile.secondaryEducation?.tenth?.percentage;
    case 'education.tenth.passingYear':
      return profile.secondaryEducation?.tenth?.year;
    case 'education.tenth.board':
      return profile.secondaryEducation?.tenth?.board;

    // ---- Experience ----
    case 'experience.current.companyName':
    case 'experience.latest.company':
      return profile.experience[0]?.company || (profile.experience.length === 0 ? 'Fresher' : 'N/A');
    case 'experience.current.jobTitle':
    case 'experience.latest.title':
      return profile.experience[0]?.title || (profile.experience.length === 0 ? 'Fresher' : undefined);
    case 'experience.current.location':
    case 'experience.latest.location':
      return profile.experience[0]?.location;
    case 'experience.current.startDate':
    case 'experience.latest.startDate':
      return profile.experience[0]?.startDate;
    case 'experience.current.endDate':
    case 'experience.latest.endDate':
      return profile.experience[0]?.endDate;
    case 'experience.current.description':
    case 'experience.latest.description':
      return profile.experience[0]?.description;
    case 'experience.current.isCurrentlyEmployed':
      return profile.experience[0]?.current !== undefined
        ? (profile.experience[0].current ? 'Yes' : 'No')
        : (profile.experience.length === 0 ? 'No' : undefined);
    case 'experience.total':
    case 'experience.totalYears':
      return calculateTotalExperience(profile);

    // ---- Professional ----
    case 'professional.linkedinProfileUrl':
    case 'professional.linkedin':
      return profile.professional.linkedin;
    case 'professional.githubProfileUrl':
    case 'professional.github':
      return profile.professional.github;
    case 'professional.portfolioUrl':
    case 'professional.portfolio':
      return profile.professional.portfolio;
    case 'professional.skills':
      return profile.professional.skills.length > 0
        ? profile.professional.skills.join(', ')
        : undefined;
    case 'professional.currentCtc':
      return profile.professional.currentCtc || (profile.experience.length === 0 ? 'Fresher' : 'N/A');
    case 'professional.expectedCtc':
      return profile.professional.expectedCtc || 'As per company norms';
    case 'professional.noticePeriod':
      return profile.professional.noticePeriod || 'Immediate';

    // ---- Application ----
    case 'application.expectedJoiningDate': {
      const today = new Date();
      const year = today.getFullYear();
      const month = String(today.getMonth() + 1).padStart(2, '0');
      const day = String(today.getDate()).padStart(2, '0');
      return `${year}-${month}-${day}`;
    }
    case 'application.additionalInformation':
      return profile.professional.additionalInformation || 'N/A';

    default:
      return undefined;
  }
}

/**
 * Create field mappings from detected fields and the user's profile.
 * Only creates mappings for fields that:
 * 1. Have a matched profile field
 * 2. Have a profile value available
 * 3. Are categorized as SAFE_AUTO
 */
export function createFieldMappings(
  fields: DetectedField[],
  profile: UserProfile,
): FieldMapping[] {
  const mappings: FieldMapping[] = [];

  for (const field of fields) {
    if (field.category !== 'SAFE_AUTO' || !field.profileField) continue;

    const value = resolveProfileValueForField(profile, field);
    if (!value) continue;

    mappings.push({
      selector: field.selector,
      profileField: field.profileField,
      value,
      confidence: field.confidence,
    });
  }

  return mappings;
}
