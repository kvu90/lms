/**
 * Đáp ứng kỳ vọng của `GET /users/me/capabilities` cho các vai mẫu của
 * spec `users-my-access-equivalence.e2e-spec.ts`.
 *
 * Nguồn gốc: chụp từ CHÍNH đáp ứng của cài đặt TRƯỚC khi phân giải theo
 * lô (đường gọi `hasCapability` tuần tự từng cặp context × capability)
 * trên cùng một bộ dữ kiện dựng giống hệt (cùng cây context, cùng
 * override trên vai tuỳ chỉnh, cùng các gán vai) — đây là mốc tương
 * đương mà cài đặt theo lô phải khớp TỪNG TRƯỜNG. Vai tuỳ chỉnh được
 * chuẩn hoá thành `customrole` (shortname thật là ngẫu nhiên theo lượt
 * chạy), context được chuẩn hoá theo nhãn vị trí trong cây dựng sẵn.
 * Khi sổ đăng ký capability hoặc mặc định archetype thay đổi có chủ
 * đích, mốc này phải được chụp lại và rà soát như một thay đổi hành vi.
 */
export interface ExpectedContextSnapshot { context: string; level: number; capabilities: string[] }
export interface ExpectedUserSnapshot {
  isSiteAdmin: boolean;
  hasLearnerArtifacts: boolean;
  assignments: { role: string; context: string }[];
  contexts: ExpectedContextSnapshot[];
}
export const EXPECTED_SNAPSHOTS: Record<string, ExpectedUserSnapshot> = {
  "teacherMulti": {
    "isSiteAdmin": false,
    "hasLearnerArtifacts": false,
    "assignments": [
      {
        "role": "customrole",
        "context": "class"
      },
      {
        "role": "customrole",
        "context": "course"
      },
      {
        "role": "editingteacher",
        "context": "course"
      },
      {
        "role": "teacher",
        "context": "class"
      }
    ],
    "contexts": [
      {
        "context": "class",
        "level": 45,
        "capabilities": [
          "site:config",
          "site:viewuseridentity",
          "user:viewdetails",
          "course:view",
          "files:view",
          "files:upload",
          "course:viewhiddencourses",
          "course:viewhiddenactivities",
          "group:accessallgroups",
          "cohort:view",
          "completion:markothers",
          "grade:edit",
          "grade:viewall",
          "grade:publish",
          "guardian:manage",
          "question:add",
          "question:useall",
          "question:copy",
          "question:share",
          "matrix:use",
          "matrix:add",
          "matrix:edit",
          "matrix:copy",
          "matrix:share",
          "quiz:view",
          "quiz:grade",
          "quiz:gradepaper",
          "quiz:viewreports",
          "quiz:preview",
          "assign:view",
          "assign:grade",
          "assign:viewallsubmissions",
          "curriculum:view",
          "site:sendmessage",
          "moderation:manage",
          "calendar:manageentries",
          "calendar:manageownentries",
          "badges:awardbadge",
          "competency:planmanage",
          "competency:planview",
          "competency:usercompetencyreview",
          "tag:edit",
          "comment:view",
          "comment:post",
          "comment:delete",
          "rating:view",
          "rating:viewall",
          "rating:rate",
          "notes:create",
          "notes:view",
          "search:use",
          "analytics:viewinsights",
          "log:view",
          "reportbuilder:manage",
          "reportbuilder:view",
          "contentbank:viewcontent",
          "contentbank:upload",
          "payment:pay",
          "privacy:request"
        ]
      },
      {
        "context": "course",
        "level": 50,
        "capabilities": [
          "site:viewuseridentity",
          "user:viewdetails",
          "course:view",
          "files:view",
          "files:upload",
          "course:update",
          "course:viewhiddencourses",
          "course:viewhiddenactivities",
          "course:manageactivities",
          "course:managegroups",
          "class:create",
          "group:accessallgroups",
          "cohort:view",
          "enrol:manage",
          "completion:manage",
          "completion:markothers",
          "grade:manage",
          "grade:edit",
          "grade:viewall",
          "grade:publish",
          "guardian:manage",
          "question:managecategory",
          "question:add",
          "question:editall",
          "question:useall",
          "question:copy",
          "question:share",
          "question:moderate",
          "matrix:use",
          "matrix:add",
          "matrix:edit",
          "matrix:copy",
          "matrix:share",
          "matrix:moderate",
          "exam:use",
          "exam:add",
          "exam:edit",
          "exam:copy",
          "exam:share",
          "exam:moderate",
          "exam:deploy",
          "quiz:view",
          "quiz:manage",
          "quiz:grade",
          "quiz:gradepaper",
          "quiz:viewreports",
          "quiz:preview",
          "quiz:manageoverrides",
          "assign:view",
          "assign:manage",
          "assign:grade",
          "assign:viewallsubmissions",
          "curriculum:view",
          "site:sendmessage",
          "moderation:manage",
          "calendar:manageentries",
          "calendar:managegroupentries",
          "calendar:manageownentries",
          "badges:createbadge",
          "badges:configurecriteria",
          "badges:awardbadge",
          "competency:planmanage",
          "competency:planview",
          "competency:usercompetencyreview",
          "competency:coursecompetencymanage",
          "tag:edit",
          "comment:view",
          "comment:post",
          "comment:delete",
          "rating:view",
          "rating:viewall",
          "rating:rate",
          "notes:create",
          "notes:view",
          "search:use",
          "backup:backupcourse",
          "backup:restorecourse",
          "analytics:viewinsights",
          "log:view",
          "reportbuilder:manage",
          "reportbuilder:view",
          "contentbank:viewcontent",
          "contentbank:upload",
          "contentbank:editcontent",
          "contentbank:reviewcontent",
          "payment:pay",
          "privacy:request"
        ]
      },
      {
        "context": "coursecat",
        "level": 40,
        "capabilities": [
          "user:viewdetails",
          "course:view",
          "site:sendmessage",
          "calendar:manageownentries",
          "competency:planmanage",
          "competency:planview",
          "tag:edit",
          "comment:view",
          "comment:post",
          "rating:view",
          "rating:rate",
          "search:use",
          "reportbuilder:view",
          "payment:pay",
          "privacy:request"
        ]
      },
      {
        "context": "system",
        "level": 10,
        "capabilities": [
          "user:viewdetails",
          "course:view",
          "site:sendmessage",
          "calendar:manageownentries",
          "competency:planmanage",
          "competency:planview",
          "tag:edit",
          "comment:view",
          "comment:post",
          "rating:view",
          "rating:rate",
          "search:use",
          "reportbuilder:view",
          "payment:pay",
          "privacy:request"
        ]
      }
    ]
  },
  "teacherOne": {
    "isSiteAdmin": false,
    "hasLearnerArtifacts": false,
    "assignments": [
      {
        "role": "editingteacher",
        "context": "course2"
      }
    ],
    "contexts": [
      {
        "context": "course2",
        "level": 50,
        "capabilities": [
          "site:viewuseridentity",
          "user:viewdetails",
          "course:view",
          "files:view",
          "files:upload",
          "course:update",
          "course:viewhiddencourses",
          "course:viewhiddenactivities",
          "course:manageactivities",
          "course:managegroups",
          "class:create",
          "group:accessallgroups",
          "cohort:view",
          "enrol:manage",
          "completion:manage",
          "completion:markothers",
          "grade:manage",
          "grade:edit",
          "grade:viewall",
          "grade:publish",
          "guardian:manage",
          "question:managecategory",
          "question:add",
          "question:editall",
          "question:useall",
          "question:copy",
          "question:share",
          "question:moderate",
          "matrix:use",
          "matrix:add",
          "matrix:edit",
          "matrix:copy",
          "matrix:share",
          "matrix:moderate",
          "exam:use",
          "exam:add",
          "exam:edit",
          "exam:copy",
          "exam:share",
          "exam:moderate",
          "exam:deploy",
          "quiz:view",
          "quiz:manage",
          "quiz:grade",
          "quiz:gradepaper",
          "quiz:viewreports",
          "quiz:preview",
          "quiz:manageoverrides",
          "assign:view",
          "assign:manage",
          "assign:grade",
          "assign:viewallsubmissions",
          "curriculum:view",
          "site:sendmessage",
          "moderation:manage",
          "calendar:manageentries",
          "calendar:managegroupentries",
          "calendar:manageownentries",
          "badges:createbadge",
          "badges:configurecriteria",
          "badges:awardbadge",
          "competency:planmanage",
          "competency:planview",
          "competency:usercompetencyreview",
          "competency:coursecompetencymanage",
          "tag:edit",
          "comment:view",
          "comment:post",
          "comment:delete",
          "rating:view",
          "rating:viewall",
          "rating:rate",
          "notes:create",
          "notes:view",
          "search:use",
          "backup:backupcourse",
          "backup:restorecourse",
          "analytics:viewinsights",
          "log:view",
          "reportbuilder:manage",
          "reportbuilder:view",
          "contentbank:viewcontent",
          "contentbank:upload",
          "contentbank:editcontent",
          "contentbank:reviewcontent",
          "payment:pay",
          "privacy:request"
        ]
      },
      {
        "context": "coursecat",
        "level": 40,
        "capabilities": [
          "user:viewdetails",
          "course:view",
          "site:sendmessage",
          "calendar:manageownentries",
          "competency:planmanage",
          "competency:planview",
          "tag:edit",
          "comment:view",
          "comment:post",
          "rating:view",
          "rating:rate",
          "search:use",
          "reportbuilder:view",
          "payment:pay",
          "privacy:request"
        ]
      },
      {
        "context": "system",
        "level": 10,
        "capabilities": [
          "user:viewdetails",
          "course:view",
          "site:sendmessage",
          "calendar:manageownentries",
          "competency:planmanage",
          "competency:planview",
          "tag:edit",
          "comment:view",
          "comment:post",
          "rating:view",
          "rating:rate",
          "search:use",
          "reportbuilder:view",
          "payment:pay",
          "privacy:request"
        ]
      }
    ]
  },
  "studentPlain": {
    "isSiteAdmin": false,
    "hasLearnerArtifacts": false,
    "assignments": [
      {
        "role": "student",
        "context": "system"
      }
    ],
    "contexts": [
      {
        "context": "system",
        "level": 10,
        "capabilities": [
          "user:viewdetails",
          "course:view",
          "files:view",
          "files:upload",
          "quiz:view",
          "quiz:attempt",
          "assign:view",
          "assign:submit",
          "site:sendmessage",
          "calendar:manageownentries",
          "competency:planmanage",
          "competency:planview",
          "tag:edit",
          "comment:view",
          "comment:post",
          "rating:view",
          "rating:rate",
          "search:use",
          "reportbuilder:view",
          "contentbank:viewcontent",
          "payment:pay",
          "privacy:request"
        ]
      }
    ]
  },
  "plainUser": {
    "isSiteAdmin": false,
    "hasLearnerArtifacts": false,
    "assignments": [],
    "contexts": [
      {
        "context": "system",
        "level": 10,
        "capabilities": [
          "user:viewdetails",
          "course:view",
          "site:sendmessage",
          "calendar:manageownentries",
          "competency:planmanage",
          "competency:planview",
          "tag:edit",
          "comment:view",
          "comment:post",
          "rating:view",
          "rating:rate",
          "search:use",
          "reportbuilder:view",
          "payment:pay",
          "privacy:request"
        ]
      }
    ]
  }
};
