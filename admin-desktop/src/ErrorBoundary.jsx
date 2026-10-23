import React from 'react';

export default class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidCatch(error) {
    if (import.meta.env.DEV) console.error('Admin interface render error:', error);
  }

  render() {
    if (this.state.hasError) {
      return (
        <main className="login-screen" dir="rtl">
          <section className="login-card" role="alert">
            <h1>אירעה תקלה בממשק הניהול</h1>
            <p>לא בוצע שינוי בנתוני החנות. טענו מחדש או פנו לתמיכה.</p>
            <button className="primary-btn" type="button" onClick={() => window.location.reload()}>טעינה מחדש</button>
          </section>
        </main>
      );
    }
    return this.props.children;
  }
}
