import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";

type GeneratedQuestion = {
  title: string;
  factsIssue: string;
  difficulty: string;
  recommendedAnswer: {
    answerA: string;
    legalBasisL: string;
    applicationA: string;
    conclusionC: string;
  };
  howToAnswer: string;
};

function parseJsonResponse(text: string): any {
  let cleaned = String(text || "").trim();

  if (cleaned.startsWith("```")) {
    cleaned = cleaned
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/i, "")
      .trim();
  }

  const firstBrace = cleaned.indexOf("{");
  const lastBrace = cleaned.lastIndexOf("}");

  if (firstBrace >= 0 && lastBrace > firstBrace) {
    cleaned = cleaned.slice(firstBrace, lastBrace + 1);
  }

  return JSON.parse(cleaned);
}

function isValidGeneratedQuestion(
  value: any
): value is GeneratedQuestion {
  return (
    value &&
    typeof value.title === "string" &&
    value.title.trim().length > 0 &&
    typeof value.factsIssue === "string" &&
    value.factsIssue.trim().length > 0 &&
    value.recommendedAnswer &&
    typeof value.recommendedAnswer.answerA === "string" &&
    typeof value.recommendedAnswer.legalBasisL === "string" &&
    typeof value.recommendedAnswer.applicationA === "string" &&
    typeof value.recommendedAnswer.conclusionC === "string" &&
    typeof value.howToAnswer === "string"
  );
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();

    const subjectSlug = String(
      body.subject ||
        body.subjectSlug ||
        body.selectedSubject ||
        ""
    ).trim();

    const focus = String(body.focus || "").trim();

    const topicSlug = body.topic
      ? String(body.topic).trim()
      : "";

    const requestedDifficulty = String(
      body.difficulty || "MEDIUM"
    ).trim();

    if (!subjectSlug) {
      return NextResponse.json(
        { error: "Please select a Bar subject." },
        { status: 400 }
      );
    }

    const subject = await prisma.subject.findUnique({
      where: { slug: subjectSlug },
    });

    if (!subject) {
      return NextResponse.json(
        { error: `Subject "${subjectSlug}" not found.` },
        { status: 404 }
      );
    }

    // Topic is required by the Question model.
    let topic: { id: string; name: string } | null = null;

    if (topicSlug) {
      topic = await prisma.topic.findFirst({
        where: {
          slug: topicSlug,
          subjectId: subject.id,
        },
        select: {
          id: true,
          name: true,
        },
      });

      if (!topic) {
        return NextResponse.json(
          { error: "The selected topic was not found for this subject." },
          { status: 404 }
        );
      }
    } else {
      // If no topic was selected, use the first topic for this subject.
      topic = await prisma.topic.findFirst({
        where: { subjectId: subject.id },
        orderBy: { name: "asc" },
        select: {
          id: true,
          name: true,
        },
      });
    }

    if (!topic) {
      return NextResponse.json(
        {
          error:
            "This subject has no topics yet. Add a topic before generating a question.",
        },
        { status: 400 }
      );
    }

    // LegalReference has topicId and questionId, not subjectId.
    // It also has createdAt, not updatedAt.
    const references = await prisma.legalReference.findMany({
      where: {
        verificationStatus: "VERIFIED",
        OR: [
          {
            topic: {
              is: {
                subjectId: subject.id,
                id: topic.id,
              },
            },
          },
          {
            question: {
              is: {
                subjectId: subject.id,
                topicId: topic.id,
              },
            },
          },
        ],
      },
      orderBy: {
        createdAt: "desc",
      },
      take: 20,
    });

    const referenceText = references
      .map(
        (ref) => `Citation: ${ref.citation}
Title: ${ref.officialTitle}
Authority: ${ref.authorityType}
Key provisions: ${ref.keyProvisionsText || "Not specified"}
Doctrine: ${ref.doctrineSummary}`
      )
      .join("\n\n");

    const topicText = `Selected topic:
${topic.name}`;

    const prompt = `
You are an expert Philippine Bar Examination question writer.

Generate ONE original Philippine Bar Examination practice question.

SUBJECT:
${subject.name}

${topicText}

FOCUS:
${focus || "Use the selected subject and topic."}

DIFFICULTY:
${requestedDifficulty}

VERIFIED LEGAL REFERENCES:
${referenceText || "No verified references were supplied."}

IMPORTANT LEGAL RULES:

1. Use Philippine law only.
2. Test actual legal reasoning and application.
3. Do NOT invent statutes, constitutional provisions, cases, doctrines, or legal citations.
4. If citing a Supreme Court case, use only a case appearing in the verified legal references above.
5. Do not manufacture facts that depend on an unknown statute or case.
6. Provide enough facts for the examinee to answer the question.
7. Ensure the issue is legally coherent and answerable.
8. Follow ALAC: Answer, Legal Basis, Application, Conclusion.
9. Directly address the facts in the recommended answer.
10. For Statutory Construction, consider relevant principles such as plain meaning, legislative intent, ejusdem generis, expressio unius est exclusio alterius, noscitur a sociis, verba legis, casus omissus, administrative construction, strict and liberal construction, retroactivity, constitutional avoidance, harmonization, repeal, and mandatory versus directory provisions.
11. Require application of a doctrine to facts rather than mere identification.
12. Use the style of Philippine Bar Examination questions.
13. Keep facts realistic and concise.
14. Explain why the legal rule applies.
15. Do not mention that you are an AI.
16. Do not present unverified legal propositions as verified authorities. If the supplied references are insufficient, do not fabricate citations.

Return ONLY valid JSON in exactly this structure:

{
  "title": "Short question title",
  "factsIssue": "Full factual scenario followed by the legal question.",
  "difficulty": "EASY | MEDIUM | HARD",
  "recommendedAnswer": {
    "answerA": "Direct answer to the legal issue.",
    "legalBasisL": "Applicable Philippine law or verified authority.",
    "applicationA": "Apply the legal rule specifically to the facts.",
    "conclusionC": "Clear final conclusion."
  },
  "howToAnswer": "Short guidance explaining how a Bar examinee should approach the question."
}

Do not include markdown fences or commentary outside the JSON.
`;

    const apiKey = process.env.OMNIROUTE_API_KEY;

    if (!apiKey) {
      return NextResponse.json(
        { error: "OMNIROUTE_API_KEY is not configured." },
        { status: 500 }
      );
    }

    const baseUrl =
      process.env.OMNIROUTE_BASE_URL ||
      "http://localhost:20128/v1";

    const primaryModel =
      process.env.OMNIROUTE_MODEL ||
      "gemini-3-flash-preview";

    const fallbackModels = [
      primaryModel,
      "gemini/gemini-3-flash-preview",
      "gemini/gemini-2.5-flash",
    ].filter(
      (model, index, array) =>
        model && array.indexOf(model) === index
    );

    let lastError: unknown = null;

    for (const model of fallbackModels) {
      try {
        console.log("Trying OmniRoute model:", model);

        const response = await fetch(
          `${baseUrl}/chat/completions`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${apiKey}`,
            },
            body: JSON.stringify({
              model,
              messages: [
                {
                  role: "system",
                  content:
                    "You are a Philippine Bar Examination question writer. Return only valid JSON.",
                },
                {
                  role: "user",
                  content: prompt,
                },
              ],
              temperature: 0.2,
              max_tokens: 4000,
            }),
          }
        );

        const data = await response.json();

        if (!response.ok) {
          lastError =
            data?.error?.message ||
            `OmniRoute request failed with status ${response.status}`;

          console.error("OmniRoute error:", {
            model,
            error: lastError,
          });

          continue;
        }

        const text =
          data?.choices?.[0]?.message?.content;

        if (!text) {
          lastError = "OmniRoute returned an empty response.";
          continue;
        }

        const parsed = parseJsonResponse(text);

        if (!isValidGeneratedQuestion(parsed)) {
          lastError = "AI returned an invalid question structure.";

          console.error("Invalid generated question:", parsed);
          continue;
        }

        const question = await prisma.question.create({
          data: {
            subjectId: subject.id,
            topicId: topic.id,
            title: parsed.title.trim(),
            factsIssue: parsed.factsIssue.trim(),
            difficulty:
              parsed.difficulty || requestedDifficulty,
            bestAnswerA:
              parsed.recommendedAnswer.answerA.trim(),
            bestAnswerL:
              parsed.recommendedAnswer.legalBasisL.trim(),
            bestAnswerA2:
              parsed.recommendedAnswer.applicationA.trim(),
            bestAnswerC:
              parsed.recommendedAnswer.conclusionC.trim(),
            howToAnswer: parsed.howToAnswer.trim(),
            questionSource: "AI_GENERATED",
            verificationStatus: "NEEDS_REVIEW",
            legalReferences: {
              connect: references.map((ref) => ({
                id: ref.id,
              })),
            },
          },
          include: {
            subject: true,
            topic: true,
            legalReferences: true,
          },
        });

        console.log(
          "Generated question successfully:",
          question.id
        );

        return NextResponse.json({ question });
      } catch (error) {
        lastError = error;

        console.error("AI generation error:", {
          model,
          error:
            error instanceof Error
              ? error.message
              : error,
        });
      }
    }

    return NextResponse.json(
      {
        error:
          lastError instanceof Error
            ? lastError.message
            : "The AI models could not generate a valid question.",
      },
      { status: 502 }
    );
  } catch (error) {
    console.error("Generate question route error:", error);

    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Unknown error",
      },
      { status: 500 }
    );
  }
}