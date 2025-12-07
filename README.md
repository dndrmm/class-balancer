# Class Balancer

![Version](https://img.shields.io/badge/version-2.0.6-blue.svg) ![License](https://img.shields.io/badge/license-MIT-green.svg) ![Status](https://img.shields.io/badge/status-stable-success.svg)

**Class Balancer** is a privacy-focused, browser-based tool designed to help educators create balanced class lists. It automates the complex process of sorting students by academic performance, gender, and behavioral needs while strictly adhering to "Keep Together" and "Separate From" constraints.

## 🔒 Privacy First Promise
**This application runs 100% in your browser.**
* No student data is ever sent to a server.
* No data is stored in a cloud database.
* Your roster data lives in your browser's memory and is wiped when you close the tab (unless you explicitly save a session file to your computer).

---

## ✨ Key Features

* **Automated Balancing Algorithm:** Instantly distributes students to minimize the deviation between class averages across multiple criteria (Reading, Math, Behavior, etc.).
* **Constraint Management:**
    * **Keep Together:** Ensure best friends or support clusters stay in the same class.
    * **Separate From:** Prevent conflicts by ensuring specific students are never placed together.
* **Drag-and-Drop Interface:** Fine-tune the algorithm's results manually. The app visually alerts you if a move violates a constraint.
* **Privacy-Safe Printing:**
    * Generates clean, paper-friendly summaries.
    * **Privacy Mode:** Hiding all score columns automatically removes sensitive data from the printout, perfect for distributing class lists to next year's teachers.
* **Dark Mode:** Fully supported interface for late-night admin work.

---

## 🚀 How to Use

### 1. Import Data
Upload a CSV file. The application is flexible but works best with the following headers (case-insensitive):
* `First Name`, `Last Name` (or a single `Name` column)
* `Gender` (M/F)
* `Tags` (e.g., "IEP", "504", "ELL" - separated by commas or semicolons)
* `Previous Teacher`
* `Notes`
* **Scores:** Any other numeric column (e.g., `Reading`, `Math`, `Composite`) will be automatically detected as a balancing factor.

**Sample CSV Format:**

    First Name,Last Name,Gender,Reading,Math,Behavior,Tags,Previous Teacher
    Ava,Smith,F,85,90,3,Gifted,Ms. Krabappel
    Liam,Johnson,M,42,60,2,"IEP; Speech",Mrs. Hoover

### 2. Configure
* **Classes:** Select the number of classes to form (1-20).
* **Weights:** Adjust the importance of each factor (Low/Normal/High). For example, if balancing "Behavior" is critical, set it to **High**.
* **Constraints:** Use the "Manual Pins" section to link students who must be kept together or separated.

### 3. Run & Refine
Click **Run Class Balancing**. The algorithm will sort students. You can then:
* Drag and drop students between classes.
* Click a student to edit their details or exclude specific students from the balancing math (e.g., for specialized placements).

### 4. Export
* **Print / PDF:** Generate a physical copy.
* **Save Session:** Download a `.json` file containing your roster and constraints to resume work later.
* **Export Roster:** Download the final class lists as a CSV.

---

## 💻 Local Development

This project is built with **React** and **Tailwind CSS**.

### Prerequisites
* Node.js installed on your machine.

### Installation

1.  Clone the repository:
    ```bash
    git clone [https://github.com/yourusername/class-balancer.git](https://github.com/yourusername/class-balancer.git)
    cd class-balancer
    ```

2.  Install dependencies:
    ```bash
    npm install
    ```

3.  Start the development server:
    ```bash
    npm run dev
    ```

4.  Open your browser to `http://localhost:5173` (or the port shown in your terminal).

---

## 📄 License

Distributed under the MIT License. See `LICENSE` for more information.
